/**
 * Everything a run has to say, as data.
 *
 * Stages used to format their own output and write it straight to stdout,
 * which meant the only way to know what a run did was to read the terminal —
 * no second renderer, no machine-readable mode, and no way to test the loop
 * without standing up agents to make it print something.
 *
 * The rule that makes this worth the indirection: **events carry data, never
 * formatted strings.** A stage reports that generation finished with 43 turns
 * and 30 tool calls; deciding that this reads as `done — 43 turns, 30 tool
 * calls` is the renderer's job. The moment an event carries a sentence, the
 * JSON renderer is reduced to quoting the terminal one.
 */
import type { Command } from "./commands.js";

/** The four stages of the loop. Named `Phase` to leave `Stage` to the commands. */
export type Phase = "doctor" | "generate" | "test" | "evaluate";

/** Wall-clock per stage across a whole run. */
export interface Timings {
  generateMs: number;
  testMs: number;
  evaluateMs: number;
}

export type HarnessEvent =
  /** Once, first. What this run was pointed at. */
  | {
      type: "run:started";
      command: "run" | "init";
      stamp: string;
      repo: string;
      /** Absolute path, when the command is `run`. */
      spec?: string | undefined;
      /** Repo-relative, when the spec lives inside the repo. */
      specInRepo?: string | undefined;
      from: string;
      head: string;
      model: string;
      maxAttempts: number;
    }
  /** One of DOCTOR's preconditions. `ok: false` is a warning, not a failure — a failure throws. */
  | { type: "check"; name: string; ok: boolean; remedy?: string }
  | { type: "phase:started"; phase: Phase; attempt?: number | undefined; detail?: string | undefined }
  | { type: "command:started"; name: string; command: Command }
  | { type: "command:skipped"; name: string; reason: string }
  /** Heartbeat from a long command: how long it has run, and its own last line. */
  | { type: "command:tick"; elapsedMs: number; line: string }
  /** One tool call by the generating or judging agent. */
  | { type: "tool"; tool: string; argument: string }
  | {
      type: "generate:finished";
      attempt: number;
      turns: number;
      toolCalls: number;
      /** Under subscription auth this is a list-price equivalent of tokens used, not money. */
      costUsd?: number | undefined;
      durationMs: number;
    }
  | {
      type: "evaluate:finished";
      attempt: number;
      verdict: "pass" | "fail" | "none";
      findings: number;
      durationMs: number;
    }
  | { type: "committed"; attempt: number; sha: string | null }
  | {
      type: "attempt:finished";
      attempt: number;
      passed: boolean;
      /** Failures that also failed the previous attempt — the signal that matters. */
      open: number;
      fixed: number;
      fresh: number;
      results: string[];
    }
  | { type: "branch"; branch: string }
  /** DOCTOR's proposed commands, before the operator confirms them. */
  | {
      type: "proposal";
      commands: Array<{ name: string; command: Command | null; note?: string | undefined }>;
    }
  /** Anything worth saying that is not one of the above. `warn` is for the unexpected-but-survivable. */
  | { type: "note"; level: "info" | "warn"; text: string }
  | {
      type: "run:finished";
      passed: boolean;
      cancelled: boolean;
      attempts: number;
      branch: string | null;
      timings: Timings;
      /** The run directory, so a renderer can point at the artifacts. */
      dir: string;
    }
  /** `init` wrote a spec skeleton. */
  | { type: "spec:written"; path: string; tailored: boolean };

export type Listener = (event: HarnessEvent) => void;

// ponytail: module-level, because a harness process is exactly one run — the
// alternative is threading an emitter through every function in the codebase
// to serve a second run that will never exist. `reset` keeps tests honest.
const listeners = new Set<Listener>();

export function emit(event: HarnessEvent): void {
  for (const listener of listeners) listener(event);
}

/** Returns the function that detaches it again. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drops every renderer. For tests, so one case cannot leak into the next. */
export function reset(): void {
  listeners.clear();
}

/** Collects events for the duration of a test, and detaches itself. */
export function collect(): { events: HarnessEvent[]; stop: () => void } {
  const events: HarnessEvent[] = [];
  const stop = subscribe((event) => events.push(event));
  return { events, stop };
}
