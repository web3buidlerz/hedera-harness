import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import { type Outcome, evaluate } from "./evaluate.js";
import { generate } from "./generate.js";
import { commitWork } from "./git.js";
import { type Timings, emit } from "./events.js";
import type { Run } from "./run.js";
import { startServer } from "./serve.js";
import { type StageFailure, describeFailure, runStages } from "./test.js";

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
  results: string[];
  /** Stable identity per failure, so repeats across attempts are detectable. */
  hashes: string[];
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

    previous = new Set(feedback.hashes);
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

  if (failure !== null) return fromStage(failure);

  const server = await startServer(config.serve, repoRoot);
  const evaluateStarted = Date.now();
  try {
    return fromVerdict(await withOneRetry(options, attempt, server.url));
  } finally {
    timings.evaluateMs += Date.now() - evaluateStarted;
    await server.stop();
  }
}

/**
 * A verdict is final and never re-rolled. Only the absence of one earns a
 * second look, and only once — a second miss is the evaluator failing, not
 * the app, so the run aborts rather than charging it to the generator.
 */
async function withOneRetry(
  options: LoopOptions,
  attempt: number,
  appUrl: string,
): Promise<Outcome> {
  const { repoRoot, run, specPath } = options;
  const first = await evaluate({ repoRoot, run, specPath, attempt, appUrl, model: options.model });
  if (first.type === "verdict") return first;

  emit({
    type: "note",
    level: "warn",
    text: `no verdict (${first.reason}) — evaluating once more against the same commit`,
  });
  const second = await evaluate({ repoRoot, run, specPath, attempt, appUrl, model: options.model });
  if (second.type === "verdict") return second;

  throw new AbortRun(
    `the evaluator produced no verdict twice against the same commit: ${second.reason}`,
  );
}

function fromStage(failure: StageFailure): Feedback {
  const line = describeFailure(failure);
  return {
    ok: false,
    results: [line],
    hashes: [identity(failure.stage, firstError(failure.output))],
    detail: failure.output.slice(-OUTPUT_TAIL),
  };
}

function fromVerdict(outcome: Outcome): Feedback {
  if (outcome.type !== "verdict") throw new AbortRun(outcome.reason);
  if (outcome.verdict.pass) return { ok: true, results: [], hashes: [] };

  return {
    ok: false,
    results: outcome.verdict.failures.map(
      (failure) => `${failure.where}: ${failure.what} [${failure.evidence.join(", ")}]`,
    ),
    // Hashed on `where` alone. `what` is prose from a fresh evaluator, so it
    // is worded differently every attempt and would make one recurring bug
    // look like a new one each time — which is exactly the signal this is for.
    hashes: outcome.verdict.failures.map((failure) => identity(failure.where)),
  };
}

/**
 * Two attempts failing the same way is the signal that matters — it separates
 * an agent converging from one trading one failure for another.
 */
function report(attempt: number, feedback: Feedback, previous: Set<string>): boolean {
  if (feedback.ok) {
    emit({ type: "attempt:finished", attempt, passed: true, open: 0, fixed: 0, fresh: 0, results: [] });
    return false;
  }

  const open = feedback.hashes.filter((hash) => previous.has(hash));
  const fresh = feedback.hashes.filter((hash) => !previous.has(hash));
  const fixed = [...previous].filter((hash) => !feedback.hashes.includes(hash));

  emit({
    type: "attempt:finished",
    attempt,
    passed: false,
    open: open.length,
    fixed: fixed.length,
    fresh: fresh.length,
    results: feedback.results,
  });
  return open.length > 0;
}

function repairPrompt(feedback: Feedback): string {
  return [
    "That attempt did not pass. What went wrong:",
    "",
    ...feedback.results.map((line) => `- ${line}`),
    feedback.detail === undefined ? "" : `\n${feedback.detail}`,
    "",
    "Fix it, then stop. Do not start the dev server or run the checks yourself —",
    "they run automatically once you are done.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** First line that looks like an error, so cosmetic output changes do not shift the hash. */
function firstError(output: string): string {
  const line = output
    .split("\n")
    .find((candidate) => /\b(error|failed|cannot|not found|exception)\b/i.test(candidate));
  return (line ?? output.split("\n")[0] ?? "").trim().replace(/\d+/g, "N").slice(0, 200);
}

function identity(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

async function writeFeedback(run: Run, attempt: number, feedback: Feedback): Promise<void> {
  const body = { ok: feedback.ok, results: feedback.results };
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
