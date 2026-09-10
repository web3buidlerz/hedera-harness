import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Command, type CommandResult, describe, runCommand } from "./commands.js";
import type { HarnessConfig } from "./config.js";
import type { Run } from "./run.js";

/** See PLAN-V2 § Bounds. */
const COMMAND_TIMEOUT_MS = 20 * 60_000;

const FINGERPRINT_FILE = "install-fingerprint.txt";

export type Stage = "install" | "build" | "test";

export interface StageFailure {
  stage: Stage;
  command: Command;
  code: number | null;
  timedOut: boolean;
  /** Where the full output was written, for the repair prompt to point at. */
  artifact: string;
  output: string;
}

export interface StageOptions {
  config: HarnessConfig;
  repoRoot: string;
  run: Run;
  /** Artifact subdirectory — `baseline` or `attempt-2`. */
  prefix: string;
  /** Run `install` even when nothing about the dependencies changed. */
  forceInstall?: boolean;
}

/**
 * `install`, then `build`, then `test`, stopping at the first non-zero exit.
 * Returns null when everything passed, or the failure that stopped it.
 *
 * The same function serves DOCTOR's baseline and every attempt's TEST — one
 * code path, so the commands that proved the repo healthy are exactly the
 * commands the agent is later judged against.
 */
export async function runStages(options: StageOptions): Promise<StageFailure | null> {
  const { config, repoRoot, run, prefix } = options;

  const install = await installIfNeeded(options);
  if (install !== null) return install;

  const remaining: Array<[Stage, Command | null]> = [
    ["build", config.build],
    ["test", config.test],
  ];

  for (const [stage, command] of remaining) {
    if (command === null) {
      await run.log(`${prefix} ${stage} skipped (none)`);
      continue;
    }
    const failure = await runStage(stage, command, options);
    if (failure !== null) return failure;
  }
  return null;
}

/**
 * Installing is the expensive step and dependencies rarely move, so it runs
 * only when the manifests or the lockfile actually changed since last time.
 */
async function installIfNeeded(options: StageOptions): Promise<StageFailure | null> {
  const { config, repoRoot, run, prefix } = options;
  const current = await fingerprint(repoRoot);
  const recorded = await readFile(join(run.dir, FINGERPRINT_FILE), "utf8").catch(() => null);

  if (!options.forceInstall && recorded === current) {
    await run.log(`${prefix} install skipped (dependencies unchanged)`);
    return null;
  }

  const failure = await runStage("install", config.install, options);
  if (failure !== null) return failure;

  await writeFile(join(run.dir, FINGERPRINT_FILE), current);
  return null;
}

async function runStage(
  stage: Stage,
  command: Command,
  { repoRoot, run, prefix }: StageOptions,
): Promise<StageFailure | null> {
  await run.log(`${prefix} ${stage}: ${describe(command)}`);
  const result = await runCommand(command, repoRoot, COMMAND_TIMEOUT_MS);

  const artifact = join(prefix, `${stage}.txt`);
  await run.write(artifact, result.output);

  if (succeeded(result)) return null;
  return {
    stage,
    command,
    code: result.code,
    timedOut: result.timedOut,
    artifact,
    output: result.output,
  };
}

function succeeded(result: CommandResult): boolean {
  return result.code === 0 && !result.timedOut;
}

/** One line per failure, in the shape the diagram uses for `feedback.json`. */
export function describeFailure(failure: StageFailure): string {
  const what = failure.timedOut
    ? `timed out after ${COMMAND_TIMEOUT_MS / 60_000} minutes`
    : `exited ${failure.code}`;
  return `${failure.stage}: \`${describe(failure.command)}\` ${what}`;
}

/**
 * Hashes the manifests and the lockfile. Content rather than mtime, so a
 * checkout that rewrites files without changing them does not trigger a
 * reinstall.
 */
async function fingerprint(repoRoot: string): Promise<string> {
  const candidates = [
    "package.json",
    "yarn.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lockb",
  ];
  const hash = createHash("sha256");
  for (const name of candidates) {
    const source = await readFile(join(repoRoot, name)).catch(() => null);
    if (source !== null) hash.update(name).update(source);
  }
  return `${hash.digest("hex")}\n`;
}
