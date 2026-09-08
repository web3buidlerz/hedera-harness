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

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));

    const finish = (code: number | null) => {
      clearTimeout(timer);
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

function killGroup(pid: number | undefined): void {
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
