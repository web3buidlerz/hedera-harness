import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import { type Outcome, evaluate } from "./evaluate.js";
import { generate } from "./generate.js";
import { commitWork } from "./git.js";
import { formatDuration } from "./progress.js";
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
}

export interface LoopResult {
  passed: boolean;
  attempts: number;
  branch: string;
  /** Wall-clock per stage across the whole run, so the summary says where time went. */
  timings: Timings;
}

export interface Timings {
  generateMs: number;
  testMs: number;
  evaluateMs: number;
}

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
  const { config, repoRoot, run, maxAttempts } = options;

  const timings: Timings = { generateMs: 0, testMs: 0, evaluateMs: 0 };
  let prompt = options.spec;
  let session: string | undefined;
  let previous: Set<string> = new Set();
  const history: Array<{ attempt: number; feedback: Feedback }> = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await generate({ repoRoot, run, prompt, attempt, resume: session, model: options.model });
    session = generated.sessionId;
    timings.generateMs += generated.durationMs;

    const feedback = await assess(options, attempt, timings);
    history.push({ attempt, feedback });
    await writeFeedback(run, attempt, feedback);

    if (feedback.ok) {
      await report(run, attempt, feedback, previous);
      await writeResult(run, { passed: true, attempts: attempt, branch: options.branch, timings });
      return { passed: true, attempts: attempt, branch: options.branch, timings };
    }

    const repeated = await report(run, attempt, feedback, previous);
    if (attempt === maxAttempts) break;

    // A failure that survived an attempt means the resumed conversation is
    // circling it. Dropping the session is the only way out of a line of
    // reasoning the agent has already committed to.
    if (repeated) {
      session = undefined;
      await run.log(`attempt ${attempt + 1} starts a fresh session — same failure twice`);
    }

    previous = new Set(feedback.hashes);
    prompt = repairPrompt(feedback);
  }

  await writeResult(run, { passed: false, attempts: history.length, branch: options.branch, timings });
  return { passed: false, attempts: history.length, branch: options.branch, timings };
}

/**
 * TEST first, then EVALUATE only if it passed — a failing build never pays for
 * a browser. The attempt is committed once TEST is green, so the code the
 * evaluator judges is the code on the branch.
 */
async function assess(options: LoopOptions, attempt: number, timings: Timings): Promise<Feedback> {
  const { config, repoRoot, run } = options;

  const testStarted = Date.now();
  const failure = await runStages({ config, repoRoot, run, prefix: `attempt-${attempt}` });
  timings.testMs += Date.now() - testStarted;
  if (failure !== null) return fromStage(failure);

  const commit = await commitWork(`harness: attempt ${attempt}`, repoRoot);
  await run.log(commit === null ? `attempt ${attempt} changed nothing` : `attempt ${attempt} committed ${commit.slice(0, 12)}`);

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

  await run.log(`no verdict (${first.reason}) — evaluating once more against the same commit`);
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
async function report(
  run: Run,
  attempt: number,
  feedback: Feedback,
  previous: Set<string>,
): Promise<boolean> {
  if (feedback.ok) {
    await run.log(`attempt ${attempt} PASSED`);
    return false;
  }

  const open = feedback.hashes.filter((hash) => previous.has(hash));
  const fresh = feedback.hashes.filter((hash) => !previous.has(hash));
  const fixed = [...previous].filter((hash) => !feedback.hashes.includes(hash));

  await run.log(
    `attempt ${attempt} FAILED — ${open.length} open, ${fixed.length} fixed, ${fresh.length} new`,
  );
  for (const line of feedback.results) await run.log(`  ${line}`);
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
  result: { passed: boolean; attempts: number; branch: string; timings: Timings },
): Promise<void> {
  await run.writeResult(result);
}

/** `generate 7:46 · test 0:52 · evaluate 3:28` */
export function describeTimings(timings: Timings): string {
  return [
    `generate ${formatDuration(timings.generateMs)}`,
    `test ${formatDuration(timings.testMs)}`,
    `evaluate ${formatDuration(timings.evaluateMs)}`,
  ].join(" · ");
}
