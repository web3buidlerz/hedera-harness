import { dim, heading } from "./style.js";

/** Width to clip a tool's argument to, so one call is always one line. */
const ARGUMENT_WIDTH = 96;

/**
 * Live output for the two stages that take minutes.
 *
 * A run used to print one line and then go quiet for the whole of GENERATE,
 * which made a working run and a hung one look identical — the first real run
 * against a project prompted "it feels kinda stuck" while the agent was
 * mid-implementation and writing to disk every second. Everything shown here
 * was already passing through the message loop on its way to the transcript.
 *
 * Console only. `harness.log` stays a record of stage transitions, and the
 * JSONL transcript already holds every message in full.
 */
export class Progress {
  private readonly started = Date.now();
  private calls = 0;

  constructor(private readonly label: string) {}

  /** `GENERATE  attempt 2 · sonnet · 8 plugins` */
  open(detail: string): void {
    console.log(heading(this.label, detail));
  }

  /**
   * One line per tool call: elapsed, tool, and what it was pointed at. The
   * tool name is the only part at full strength — it is what the eye scans for
   * when skimming back through several hundred of these.
   */
  step(tool: string, argument: string): void {
    this.calls += 1;
    console.log(`  ${dim(this.elapsed())}  ${tool.padEnd(7)} ${dim(clip(argument))}`);
  }

  /**
   * Closing line, and the elapsed time the caller records against the stage.
   * `summary` is printed as given: EVALUATE's is the verdict, which is the one
   * thing in a stage that should not be toned down.
   */
  close(summary: string): number {
    const ms = Date.now() - this.started;
    console.log(`  ${dim(this.elapsed())}  ${summary}`);
    return ms;
  }

  get toolCalls(): number {
    return this.calls;
  }

  private elapsed(): string {
    return formatClock(Date.now() - this.started);
  }
}

/**
 * Pulls the one line worth showing out of an SDK message, or null when there
 * is nothing to say. Tool inputs vary by tool, so this reads whichever field
 * carries the subject and falls back to the tool name alone.
 */
export function describeMessage(
  message: unknown,
  root?: string,
): { tool: string; argument: string } | null {
  const candidate = message as { type?: string; message?: { content?: unknown } };
  if (candidate.type !== "assistant" || !Array.isArray(candidate.message?.content)) return null;

  for (const block of candidate.message.content as Array<Record<string, unknown>>) {
    if (block["type"] !== "tool_use") continue;
    const name = typeof block["name"] === "string" ? block["name"] : "tool";
    return { tool: shortName(name), argument: relativise(subjectOf(block["input"]), root) };
  }
  return null;
}

/**
 * Absolute paths are most of a line and none of the information — the agent
 * works in one repo, so the root is noise repeated on every row.
 */
function relativise(text: string, root: string | undefined): string {
  return root === undefined ? text : text.split(`${root}/`).join("");
}

/** `mcp__harness__submit_verdict` reads as `verdict` in a live feed. */
function shortName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

function subjectOf(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** Single line, ellipsis rather than wrapping — the transcript has the full text. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= ARGUMENT_WIDTH ? flat : `${flat.slice(0, ARGUMENT_WIDTH - 1)}…`;
}

/** `  0:04` — a running clock, right-aligned so rows line up. */
export function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`.padStart(5);
}

/**
 * `7:46` for anything over a minute, `0.3s` below it. A stage that really took
 * 278ms rounded to `0:00` in the summary, which reads as "did not run" rather
 * than "was instant".
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Under subscription auth the SDK's cost figure is a list-price equivalent of
 * the tokens used, not money leaving an account. Say so, rather than printing
 * something that reads like an invoice.
 */
export function formatTokenCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "" : `, ~$${costUsd.toFixed(2)} of tokens`;
}
