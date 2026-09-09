import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Command, describe, runCommand } from "./commands.js";
import { CONFIG_FILE, type HarnessConfig, readConfig, writeConfig } from "./config.js";
import { commit, isClean } from "./git.js";
import { type Proposal, resolveCommands } from "./resolve.js";
import type { Run } from "./run.js";

/** See PLAN-V2 § Bounds. Starting points, to be tuned once there are real runs. */
const RESOLVE_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 20 * 60_000;

export class DoctorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorError";
  }
}

export interface DoctorOptions {
  repoRoot: string;
  run: Run;
  /** Skip the first-run confirmation. Required when stdin is not a terminal. */
  assumeYes: boolean;
}

/**
 * Everything that must hold before an agent is allowed to touch the repo.
 * A check belongs here only if failing it would abort a run rather than fail a
 * test — the point is to spend four seconds instead of forty minutes.
 */
export async function doctor(options: DoctorOptions): Promise<HarnessConfig> {
  const { repoRoot, run } = options;

  await checkTooling(repoRoot, run);

  if (!(await isClean(repoRoot))) {
    throw new DoctorError(
      "the working tree has uncommitted changes. Commit or stash them first — " +
        "the run needs a known starting point to branch from.",
    );
  }
  await run.log("check tree clean");

  const existing = await readConfig(repoRoot);
  const proposal = existing === null ? await resolve(options) : null;
  const config = existing ?? proposal!.config;
  if (existing !== null) await run.log(`check commands from ${CONFIG_FILE}`);

  // Every run, not just the first. On a first run this proves the resolution
  // works before it is written down; on every run it proves the repo was
  // healthy before the agent touched it, so pre-existing breakage is never
  // charged to the generator as a failed attempt.
  await verifyByRunning(config, repoRoot, run);

  if (proposal !== null) {
    await writeConfig(repoRoot, config, proposal.notes);
    await commit([CONFIG_FILE], `chore: record harness commands in ${CONFIG_FILE}`, repoRoot);
    await run.log(`check wrote and committed ${CONFIG_FILE}`);
  }

  return config;
}

async function checkTooling(repoRoot: string, run: Run): Promise<void> {
  const missing: string[] = [];
  for (const binary of ["node", "git"]) {
    if (!(await exists(binary, repoRoot))) missing.push(binary);
  }
  if (missing.length > 0) {
    throw new DoctorError(`not on PATH: ${missing.join(", ")}`);
  }
  await run.log("check tooling");
}

async function exists(binary: string, cwd: string): Promise<boolean> {
  const result = await runCommand({ run: `command -v ${binary}` }, cwd, 10_000);
  return result.code === 0;
}

async function resolve(options: DoctorOptions): Promise<Proposal> {
  const { repoRoot, run } = options;
  await run.log("resolving commands");

  const proposal = await resolveCommands(repoRoot, RESOLVE_TIMEOUT_MS);
  const { config, notes } = proposal;

  for (const [name, command] of entries(config)) {
    if (command === null) continue;
    const problem = await scriptProblem(command, repoRoot);
    if (problem !== null) throw new DoctorError(`proposed ${name} command ${problem}`);
  }

  console.log(`\n${CONFIG_FILE} for this project:\n`);
  for (const [name, command] of entries(config)) {
    console.log(`  ${name.padEnd(8)}${command === null ? "(none)" : describe(command)}`);
    console.log(`  ${" ".repeat(8)}${notes[name as keyof typeof notes] ?? ""}\n`);
  }

  await confirm(options);
  return proposal;
}

function entries(config: HarnessConfig): Array<[string, Command | null]> {
  return [
    ["install", config.install],
    ["build", config.build],
    ["test", config.test],
    ["serve", config.serve],
  ];
}

async function confirm(options: DoctorOptions): Promise<void> {
  if (options.assumeYes) return;
  if (!process.stdin.isTTY) {
    throw new DoctorError(
      `first run needs confirmation but stdin is not a terminal. ` +
        `Re-run with --yes, or create ${CONFIG_FILE} by hand.`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Use these? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new DoctorError(`declined. Write ${CONFIG_FILE} by hand and run again.`);
    }
  } finally {
    rl.close();
  }
}

/**
 * A resolution is only worth recording once it has actually run. This is what
 * stops a plausible-looking guess from being committed to `harness.yaml`.
 */
async function verifyByRunning(
  config: HarnessConfig,
  repoRoot: string,
  run: Run,
): Promise<void> {
  const stages: Array<[string, Command | null]> = [
    ["install", config.install],
    ["build", config.build],
    ["test", config.test],
  ];

  for (const [name, command] of stages) {
    if (command === null) {
      await run.log(`baseline ${name} skipped (none)`);
      continue;
    }
    await run.log(`baseline ${name}: ${describe(command)}`);
    const result = await runCommand(command, repoRoot, COMMAND_TIMEOUT_MS);
    await run.write(`baseline-${name}.txt`, result.output);

    if (result.timedOut) {
      throw new DoctorError(
        `baseline ${name} did not finish within ${COMMAND_TIMEOUT_MS / 60_000} minutes`,
      );
    }
    if (result.code !== 0) {
      throw new DoctorError(
        `baseline ${name} failed (exit ${result.code}) on the untouched repo. ` +
          `Either the command is wrong or the project is already broken — ` +
          `output is in ${run.dir}/baseline-${name}.txt`,
      );
    }
  }
}

/**
 * Checks a `yarn x` / `npm run x` command names a script that exists, before
 * anything is run. Returns null when correct, or when the command is arbitrary
 * shell we cannot check statically.
 */
async function scriptProblem(command: Command, repoRoot: string): Promise<string | null> {
  const script = scriptName(command.run);
  if (script === null) return null;

  const manifest = join(repoRoot, command.cwd ?? ".", "package.json");
  const source = await readFile(manifest, "utf8").catch(() => null);
  if (source === null) return `refers to ${command.cwd ?? "."}, which has no package.json`;

  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(source) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }

  return script in scripts
    ? null
    : `"${command.run}" names a script that does not exist in ${command.cwd ?? "."}/package.json`;
}

function scriptName(run: string): string | null {
  const words = run.trim().split(/\s+/);
  const [manager, second, third] = words;
  if (manager === "npm" || manager === "pnpm") {
    if (second === "run" && third !== undefined && words.length === 3) return third;
    return null;
  }
  if (manager === "yarn" && second !== undefined && words.length === 2) {
    return second === "install" ? null : second;
  }
  return null;
}
