import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "../commands.js";
import type { HarnessEvent } from "../events.js";
import { describeFailure } from "../failure.js";
import { ARTIFACT_DIR } from "../run.js";
import {
  bold,
  clip,
  describeTimings,
  dim,
  formatDuration,
  frame,
  green,
  red,
  verdict,
  yellow,
} from "../style.js";

const EVENTS_FILE = "events.jsonl";

/** Enough to see what kind of evidence there is; the rest is a directory listing. */
const EVIDENCE_SHOWN = 8;

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export interface ReportOptions {
  repoRoot: string;
  /** A run's timestamp. Omitted means the most recent. */
  run?: string | undefined;
  /** Include both agents' full tool feeds. */
  full: boolean;
}

/**
 * Reads a finished run back.
 *
 * A run is watched; a finished run is sat with. The job here is narrower than
 * "show the run again": it is to make the adjudication **checkable**. The
 * harness's whole claim is that it does not take the agent's word for anything
 * — but on the first real run, establishing that the verdict was honest meant
 * hand-running four `jq` commands and opening evidence files. A guarantee that
 * costs that much to verify is one most people will take on trust, which is the
 * thing it exists to avoid.
 *
 * So the emphasis is on what the evaluator did and what it saved, and on
 * anomalies the live output passes over — that same run needed two evaluation
 * passes, because the first ended without a verdict, and nothing said so.
 */
export async function report(options: ReportOptions): Promise<void> {
  const dir = await locate(options);
  const events = await load(dir);

  const started = find(events, "run:started");
  const finished = find(events, "run:finished");
  const byAttempt = group(events);

  console.log(`\n${bold("report")}  ${dim(started?.stamp ?? dir)}`);
  summary(events, started, finished);
  for (const [attempt, mine] of byAttempt) {
    await section(dir, events, attempt, mine, options.full);
  }
  next(dir, finished);
}

function summary(
  events: HarnessEvent[],
  started: Extract<HarnessEvent, { type: "run:started" }> | undefined,
  finished: Extract<HarnessEvent, { type: "run:finished" }> | undefined,
): void {
  const verdict =
    finished === undefined
      ? yellow("UNFINISHED")
      : finished.cancelled
        ? yellow("CANCELLED")
        : finished.passed
          ? green("PASSED")
          : red("FAILED");

  const lines = [`${verdict} ${dim(`after ${finished?.attempts ?? "?"} attempt(s)`)}`];
  if (finished !== undefined && !finished.cancelled) {
    lines.push(dim(describeTimings(finished.timings)));
  }
  // The first thing a run could not tell you: what it cost in total. Generation
  // reported its own spend and evaluation reported none, so the number on
  // screen was always the smaller half.
  const spend = cost(events);
  if (spend !== null) {
    // Runs from before evaluation reported its spend would otherwise show the
    // generator's half and call it the total, which is how I came to quote a
    // $1.26 run at $0.70.
    lines.push(dim(`~$${spend.total.toFixed(2)} of tokens${spend.partial ? " (generation only)" : " in total"}`));
  }
  console.log(`\n${frame(lines)}`);

  if (started === undefined) return;
  console.log(`\n${dim("repo  ")} ${started.repo}`);
  console.log(`${dim("spec  ")} ${started.specInRepo ?? started.spec ?? "—"}`);
  console.log(`${dim("from  ")} ${started.from} ${dim(`at ${started.head}`)}`);
  console.log(`${dim("model ")} ${started.model}`);
}

/** One attempt, in the order it happened: build it, test it, judge it. */
async function section(
  dir: string,
  events: HarnessEvent[],
  attempt: number,
  mine: HarnessEvent[],
  full: boolean,
): Promise<void> {
  const outcome = mine.find((event) => event.type === "attempt:finished");
  const label = outcome === undefined ? yellow("unfinished") : outcome.passed ? green("passed") : red("failed");
  console.log(`\n${bold(`ATTEMPT ${attempt}`)}  ${label}`);

  const generated = mine.find((event) => event.type === "generate:finished");
  if (generated !== undefined) {
    const spend = generated.costUsd === undefined ? "" : ` · ~$${generated.costUsd.toFixed(2)}`;
    console.log(
      `  ${"generate".padEnd(9)} ${dim(formatDuration(generated.durationMs).padStart(6))}  ` +
        dim(`${generated.turns} turns · ${generated.toolCalls} tool calls${spend}`),
    );
  }

  const commands = mine.filter(
    (event) => event.type === "command:started" || event.type === "command:skipped",
  );
  if (commands.length > 0) {
    const shown = commands.map((event) =>
      event.type === "command:skipped"
        ? `${event.name} (skipped)`
        : `${event.name}: ${describe(event.command)}`,
    );
    console.log(`  ${"test".padEnd(9)} ${dim("      ")}  ${dim(shown.join(" · "))}`);
  }

  const evaluations = mine.filter((event) => event.type === "evaluate:finished");
  if (evaluations.length > 0) {
    const total = evaluations.reduce((sum, event) => sum + event.durationMs, 0);
    const last = evaluations[evaluations.length - 1];
    console.log(
      `  ${"evaluate".padEnd(9)} ${dim(formatDuration(total).padStart(6))}  ` +
        `${verdictOf(last)}${dim(evaluations.length > 1 ? ` · ${evaluations.length} passes` : "")}`,
    );
  }

  // Anomalies the live output slides past. The one real occurrence — an
  // evaluator that ended its turn without answering — was invisible in a
  // summary that said "PASSED after 1 attempt".
  for (const note of mine.filter((event) => event.type === "note")) {
    console.log(`  ${yellow("!")} ${dim(note.text)}`);
  }

  if (outcome !== undefined && !outcome.passed) {
    const earlier = seenBefore(events, attempt);
    console.log(
      `\n  ${dim(`${outcome.open} open · ${outcome.fixed} fixed · ${outcome.fresh} new`)}`,
    );
    for (const failure of outcome.failures) {
      const again = earlier.has(failure.id) ? dim("  (still open)") : "";
      console.log(`    ${describeFailure(failure)}${again}`);
    }
  }

  await audit(dir, mine, attempt, full);
}

/**
 * What the evaluator actually did, and what it left behind. This is the part
 * that makes a verdict something you can check rather than something you accept.
 */
async function audit(
  dir: string,
  mine: HarnessEvent[],
  attempt: number,
  full: boolean,
): Promise<void> {
  // Split by whose calls they were. The generator's count is already on its own
  // line; what belongs here is the judge's work, because that is the part a
  // verdict rests on.
  const byPhase = tools(mine);
  const judged = byPhase.get("evaluate") ?? [];
  const files = await readdir(join(dir, `attempt-${attempt}`, "evidence")).catch(() => [] as string[]);
  if (judged.length === 0 && files.length === 0) return;

  if (files.length > 0) {
    const images = files.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).length;
    console.log(
      `\n  ${dim("evidence")}  attempt-${attempt}/evidence/  ` +
        dim(`${files.length} files${images > 0 ? `, ${images} screenshots` : ""}`),
    );
    for (const name of files.slice(0, EVIDENCE_SHOWN)) console.log(`    ${dim(name)}`);
    if (files.length > EVIDENCE_SHOWN) {
      console.log(`    ${dim(`… and ${files.length - EVIDENCE_SHOWN} more`)}`);
    }
  }

  if (!full) {
    if (judged.length > 0) {
      console.log(
        `\n  ${dim(`the evaluator made ${judged.length} call${judged.length === 1 ? "" : "s"} — ` +
          `harness report --full to see them`)}`,
      );
    }
    return;
  }
  for (const [phase, calls] of byPhase) {
    console.log(`\n  ${dim(`${phase} — ${calls.length} calls`)}`);
    for (const step of calls) {
      console.log(`    ${step.tool.padEnd(9)} ${dim(clip(step.argument))}`);
    }
  }
}

/**
 * Tool calls split by the phase that made them. Like the attempt itself this is
 * positional: a `tool` event says what was called, not who called it.
 */
function tools(mine: HarnessEvent[]): Map<string, Array<Extract<HarnessEvent, { type: "tool" }>>> {
  const byPhase = new Map<string, Array<Extract<HarnessEvent, { type: "tool" }>>>();
  let phase = "";
  for (const event of mine) {
    if (event.type === "phase:started") phase = event.phase;
    if (event.type !== "tool" || phase === "") continue;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), event]);
  }
  return byPhase;
}

function next(dir: string, finished: Extract<HarnessEvent, { type: "run:finished" }> | undefined): void {
  console.log("");
  if (finished?.branch != null) {
    console.log(dim("the work is on a branch:"));
    console.log(`  git switch ${finished.branch}`);
  }
  console.log(dim(`  open ${dir}`));
  console.log("");
}

function verdictOf(event: Extract<HarnessEvent, { type: "evaluate:finished" }> | undefined): string {
  return event === undefined ? dim("—") : verdict(event.verdict, event.findings);
}

/** Failure ids from every earlier attempt, so a repeat can be marked as one. */
function seenBefore(events: HarnessEvent[], attempt: number): Set<string> {
  const ids = events
    .filter((event) => event.type === "attempt:finished" && event.attempt < attempt)
    .flatMap((event) => (event.type === "attempt:finished" ? event.failures : []))
    .map((failure) => failure.id);
  return new Set(ids);
}

/**
 * Generation reports the spend of a whole session; each evaluation pass reports
 * its own. Summing across the two is the only way to a run's real total.
 */
function cost(events: HarnessEvent[]): { total: number; partial: boolean } | null {
  const spending = events.filter(
    (event): event is Extract<HarnessEvent, { type: "generate:finished" | "evaluate:finished" }> =>
      event.type === "generate:finished" || event.type === "evaluate:finished",
  );
  const amounts = spending.map((event) => event.costUsd);
  const known = amounts.filter((amount): amount is number => amount !== undefined);
  if (known.length === 0) return null;
  return {
    total: known.reduce((sum, amount) => sum + amount, 0),
    partial: known.length < amounts.length,
  };
}

/**
 * Splits the stream by attempt, by position rather than by field.
 *
 * Only some events name their attempt: a command or a warning does not, because
 * the same code path serves DOCTOR's baseline and every attempt after it. The
 * stream is ordered, though, so the last `phase:started` says whose work
 * everything after it is — which is information the file has and no single
 * event does.
 */
function group(events: HarnessEvent[]): Map<number, HarnessEvent[]> {
  const byAttempt = new Map<number, HarnessEvent[]>();
  let current: number | undefined;

  for (const event of events) {
    if (event.type === "phase:started") current = event.attempt;
    if (current === undefined) continue;
    const bucket = byAttempt.get(current) ?? [];
    bucket.push(event);
    byAttempt.set(current, bucket);
  }
  return new Map([...byAttempt].sort(([a], [b]) => a - b));
}

function find<T extends HarnessEvent["type"]>(
  events: HarnessEvent[],
  type: T,
): Extract<HarnessEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<HarnessEvent, { type: T }> => event.type === type);
}

async function load(dir: string): Promise<HarnessEvent[]> {
  const source = await readFile(join(dir, EVENTS_FILE), "utf8").catch(() => null);
  if (source === null) {
    throw new ReportError(
      `${join(dir, EVENTS_FILE)} is not there. Runs from before the harness recorded ` +
        `events cannot be reported on — their artifacts are still in ${dir}.`,
    );
  }
  return source
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as HarnessEvent);
}

async function locate(options: ReportOptions): Promise<string> {
  const runs = join(options.repoRoot, ARTIFACT_DIR, "runs");
  if (options.run !== undefined) return join(runs, options.run);

  const entries = await readdir(runs).catch(() => [] as string[]);
  const latest = entries.sort().pop();
  if (latest === undefined) throw new ReportError(`no runs yet in ${runs}`);
  return join(runs, latest);
}
