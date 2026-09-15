import { spawn } from "node:child_process";
import { join } from "node:path";

/** A command from `harness.yaml`. `cwd` is relative to the repo root. */
export interface Command {
  run: string;
  /** `| undefined` is explicit so zod's optional output assigns under exactOptionalPropertyTypes. */
  cwd?: string | undefined;
}

export interface CommandResult {
  command: Command;
  code: number | null;
  /** Combined stdout and stderr, bounded — see {@link BoundedOutput}. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Every detached child currently running. A command and a dev server both
 * outlive their parent by design — which means an interrupted run leaves them
 * holding a port unless something kills them deliberately.
 */
const live = new Set<number>();

export function trackChild(pid: number | undefined): void {
  if (pid !== undefined) live.add(pid);
}

export function untrackChild(pid: number | undefined): void {
  if (pid !== undefined) live.delete(pid);
}

/** Kills everything still running. Called when a run is interrupted. */
export function killTrackedChildren(): void {
  for (const pid of live) killGroup(pid);
  live.clear();
}

/** Called while a command is still running, so minutes of silence become visible. */
export type Tick = (elapsedMs: number, lastLine: string) => void;

/** How often a running command reports in. */
const TICK_MS = 10_000;

export function describe(command: Command): string {
  return command.cwd ? `${command.run} (in ${command.cwd})` : command.run;
}

const HEAD_BYTES = 20_000;
const TAIL_BYTES = 80_000;

/**
 * Keeps the head and tail of a stream and drops the middle. Build failures
 * announce themselves at the top, test failures at the bottom, and a repair
 * prompt wants both without carrying a hundred megabytes of progress bars.
 */
class BoundedOutput {
  private head = "";
  private tail = "";
  private dropped = 0;

  push(chunk: string): void {
    if (this.head.length < HEAD_BYTES) {
      this.head += chunk.slice(0, HEAD_BYTES - this.head.length);
      chunk = chunk.slice(HEAD_BYTES - this.head.length);
      if (chunk === "") return;
    }
    this.tail += chunk;
    if (this.tail.length > TAIL_BYTES) {
      const excess = this.tail.length - TAIL_BYTES;
      this.tail = this.tail.slice(excess);
      this.dropped += excess;
    }
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n… ${this.dropped} bytes omitted …\n${this.tail}`;
  }
}

/**
 * Runs a command through a shell so `yarn next:build` works as written.
 * On timeout the whole process group is killed — a dev server or test runner
 * that spawns children must not outlive the run that started it.
 */
export async function runCommand(
  command: Command,
  repoRoot: string,
  timeoutMs: number,
  onTick?: Tick,
): Promise<CommandResult> {
  const cwd = command.cwd ? join(repoRoot, command.cwd) : repoRoot;
  const started = Date.now();
  const output = new BoundedOutput();

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command.run, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    trackChild(child.pid);
    let timedOut = false;
    let lastLine = "";
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    // `yarn install` on a real monorepo is minutes of nothing. Reporting the
    // command's own most recent line says both that it is alive and where it is.
    const heartbeat =
      onTick === undefined
        ? undefined
        : setInterval(() => onTick(Date.now() - started, lastLine), TICK_MS);

    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      const latest = lines[lines.length - 1];
      if (latest !== undefined) lastLine = latest.trim();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (code: number | null) => {
      clearTimeout(timer);
      untrackChild(child.pid);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      resolve({
        command,
        code,
        output: output.toString(),
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (error) => {
      output.push(String(error));
      finish(null);
    });
    child.on("close", finish);
  });
}

/**
 * Kills a detached child and everything it spawned. A dev server that forks
 * workers must not outlive the run, or the next attempt's `serve` finds the
 * port taken by a process nobody owns.
 */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 5_000).unref();
  } catch {
    // already gone
  }
}
