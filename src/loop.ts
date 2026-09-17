import { writeFile } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import { type Outcome, evaluate } from "./evaluate.js";
import { generate } from "./generate.js";
import { commitWork } from "./git.js";
import { type Timings, emit } from "./events.js";
import { type AttemptFailure, describeFailure, fromStage, fromVerdict } from "./failure.js";
import type { Run } from "./run.js";
import { startServer } from "./serve.js";
import { type StageFailure, runStages } from "./test.js";

/** How much of a failing command's output the repair prompt carries. */
const OUTPUT_TAIL = 4_000;

export interface LoopOptions {
  config: HarnessConfig;
  repoRoot: string;
  run: Run;
  specPath: string;
  spec: string;
  branch: string;
  maxAttempts: number;
  model: string;
  /** Repo-relative spec path, when it lives in the repo. Never committed as work. */
  specInRepo?: string | undefined;
}

export interface LoopResult {
  passed: boolean;
  attempts: number;
  branch: string;
  /** Wall-clock per stage across the whole run, so the summary says where time went. */
  timings: Timings;
}

export type { Timings };

/** What an attempt failed on, in the shape the diagram uses for `feedback.json`. */
interface Feedback {
  ok: boolean;
  failures: AttemptFailure[];
  /** Command output, carried to the repair prompt but not to `feedback.json`. */
  detail?: string;
}

export class AbortRun extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortRun";
  }
}

/**
 * GENERATE → TEST → EVALUATE, repairing until the spec is met or the budget
 * is spent. The agent decides how to fix things; this decides whether it did.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const { repoRoot, run, maxAttempts } = options;

  const timings: Timings = { generateMs: 0, testMs: 0, evaluateMs: 0 };
  // Recorded once: what the agent could reach. A run that behaves differently
  // from another is usually a different skill set, and this is the record of it.
  let skills: string[] = [];
  let prompt = options.spec;
  let session: string | undefined;
  let previous: Set<string> = new Set();
  const history: Array<{ attempt: number; feedback: Feedback }> = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await generate({ repoRoot, run, prompt, attempt, resume: session, model: options.model });
    session = generated.sessionId;
    timings.generateMs += generated.durationMs;
    if (skills.length === 0) skills = generated.skills;

    const feedback = await assess(options, attempt, timings);
    history.push({ attempt, feedback });
    await writeFeedback(run, attempt, feedback);

    if (feedback.ok) {
      report(attempt, feedback, previous);
      await writeResult(run, { passed: true, attempts: attempt, branch: options.branch, timings, skills });
      return { passed: true, attempts: attempt, branch: options.branch, timings };
    }

    const repeated = report(attempt, feedback, previous);
    if (attempt === maxAttempts) break;

    // A failure that survived an attempt means the resumed conversation is
    // circling it. Dropping the session is the only way out of a line of
    // reasoning the agent has already committed to.
    if (repeated) {
      session = undefined;
      emit({
        type: "note",
        level: "warn",
        text: `attempt ${attempt + 1} starts a fresh session — same failure twice`,
      });
    }

    previous = new Set(feedback.failures.map((failure) => failure.id));
    prompt = repairPrompt(feedback);
  }

  await writeResult(run, { passed: false, attempts: history.length, branch: options.branch, timings, skills });
  return { passed: false, attempts: history.length, branch: options.branch, timings };
}

/**
 * TEST first, then EVALUATE only if it passed — a failing build never pays for
 * a browser. The attempt is committed once TEST is green, so the code the
 * evaluator judges is the code on the branch.
 */
async function assess(options: LoopOptions, attempt: number, timings: Timings): Promise<Feedback> {
  const { config, repoRoot, run } = options;

  emit({ type: "phase:started", phase: "test", attempt });
  const testStarted = Date.now();
  const failure = await runStages({ config, repoRoot, run, prefix: `attempt-${attempt}` });
  timings.testMs += Date.now() - testStarted;

  // Every attempt is committed, passing or not. A failing attempt left
  // uncommitted used to lock the harness out of itself: the next run hit
  // DOCTOR's clean-tree check and refused, with the cleanup left to you.
  // It is also the change you most want to read after a failure.
  const outcome = failure === null ? "passed tests" : `failed ${failure.stage}`;
  const commit = await commitWork(
    `harness: attempt ${attempt} (${outcome})`,
    repoRoot,
    options.specInRepo === undefined ? [] : [options.specInRepo],
  );
  emit({ type: "committed", attempt, sha: commit });

  if (failure !== null) return stageFeedback(failure);

  const server = await startServer(config.serve, repoRoot);
  const evaluateStarted = Date.now();
  try {
    return verdictFeedback(
      await evaluate({ repoRoot, run, specPath: options.specPath, attempt, appUrl: server.url, model: options.model }),
    );
  } finally {
    timings.evaluateMs += Date.now() - evaluateStarted;
    await server.stop();
  }
}

function stageFeedback(failure: StageFailure): Feedback {
  return {
    ok: false,
    failures: [fromStage(failure)],
    detail: failure.output.slice(-OUTPUT_TAIL),
  };
}

function verdictFeedback(outcome: Outcome): Feedback {
  if (outcome.type !== "verdict") throw new AbortRun(outcome.reason);
  if (outcome.verdict.pass) return { ok: true, failures: [] };
  return { ok: false, failures: fromVerdict(outcome.verdict) };
}

/**
 * Two attempts failing the same way is the signal that matters — it separates
 * an agent converging from one trading one failure for another.
 */
function report(attempt: number, feedback: Feedback, previous: Set<string>): boolean {
  if (feedback.ok) {
    emit({ type: "attempt:finished", attempt, passed: true, open: 0, fixed: 0, fresh: 0, failures: [] });
    return false;
  }

  const now = feedback.failures.map((failure) => failure.id);
  const open = now.filter((id) => previous.has(id));
  const fixed = [...previous].filter((id) => !now.includes(id));

  emit({
    type: "attempt:finished",
    attempt,
    passed: false,
    open: open.length,
    fixed: fixed.length,
    fresh: now.length - open.length,
    failures: feedback.failures,
  });
  return open.length > 0;
}

function repairPrompt(feedback: Feedback): string {
  return [
    "That attempt did not pass. What went wrong:",
    "",
    ...feedback.failures.map((failure) => `- ${describeFailure(failure)}`),
    feedback.detail === undefined ? "" : `\n${feedback.detail}`,
    "",
    "Fix it, then stop. Do not start the dev server or run the checks yourself —",
    "they run automatically once you are done.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function writeFeedback(run: Run, attempt: number, feedback: Feedback): Promise<void> {
  const body = { ok: feedback.ok, failures: feedback.failures };
  await writeFile(
    await run.path(`attempt-${attempt}`, "feedback.json"),
    `${JSON.stringify(body, null, 2)}\n`,
  );
}

async function writeResult(
  run: Run,
  result: { passed: boolean; attempts: number; branch: string; timings: Timings; skills: string[] },
): Promise<void> {
  await run.writeResult(result);
}
