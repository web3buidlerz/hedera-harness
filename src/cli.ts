#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, readConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { initialise } from "./init.js";
import { describeTimings, runLoop } from "./loop.js";
import { createBranch, currentBranch, headCommit, repoRoot, switchBranch } from "./git.js";
import { Run, ensureExcluded, timestamp } from "./run.js";

const USAGE = `usage: harness init [name] [--model NAME] [--yes]
       harness run --spec <path> [--max-attempts N] [--model NAME] [--yes]

Run from inside the target repository.

  init [name]         set the project up: work out its commands, and draft
                      specs/<name>.md for you to fill in (default: feature)
  run --spec <path>   build the feature described by a spec

  --spec <path>        the feature to build
  --max-attempts N    repair attempts before giving up (default 3)
  --model NAME        agent model: sonnet (default), opus, haiku, or a full id
  --yes               skip the first-run command confirmation`;

class UsageError extends Error {}

type Command = "init" | "run";

interface Options {
  command: Command;
  /** `init`'s optional name, becoming `specs/<name>.md`. */
  name: string;
  spec: string;
  maxAttempts: number;
  model: string;
  assumeYes: boolean;
}

/** Pinned rather than inherited, so a run does not change meaning when the CLI's default moves. */
const DEFAULT_MODEL = process.env["HARNESS_MODEL"] ?? "sonnet";

function parse(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") throw new UsageError(USAGE);
  if (command !== "run" && command !== "init") {
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }

  let values;
  let positionals: string[] = [];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        spec: { type: "string" },
        "max-attempts": { type: "string", default: "3" },
        model: { type: "string", default: DEFAULT_MODEL },
        yes: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`);
  }

  if (command === "run" && values.spec === undefined) {
    throw new UsageError(`--spec is required\n\n${USAGE}`);
  }

  const maxAttempts = Number(values["max-attempts"]);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new UsageError(`--max-attempts must be a positive integer`);
  }

  return {
    command,
    name: positionals[0] ?? "feature",
    spec: values.spec === undefined ? "" : resolve(values.spec),
    maxAttempts,
    model: values.model,
    assumeYes: values.yes,
  };
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);

  if (options.command === "run") {
    await access(options.spec, constants.R_OK).catch(() => {
      throw new Error(`cannot read spec: ${options.spec}`);
    });
  }

  const root = await repoRoot(process.cwd());
  await ensureExcluded(root);

  const stamp = timestamp();
  const run = await Run.create(root, stamp);
  const branch = `harness/${stamp}`;

  await run.log(`run ${stamp}`);
  await run.log(`repo ${root}`);
  if (options.command === "run") await run.log(`spec ${options.spec}`);
  const startedOn = await currentBranch(root);
  await run.log(`from ${startedOn} at ${(await headCommit(root)).slice(0, 12)}`);
  await run.log(`max-attempts ${options.maxAttempts}, model ${options.model}`);

  // DOCTOR runs before the branch exists: harness.yaml describes the project,
  // so it is committed where the project lives, not on a throwaway run branch.
  const specInRepo = options.command === "run" ? insideRepo(root, options.spec) : undefined;
  await doctor({
    repoRoot: root,
    run,
    model: options.model,
    specPath: specInRepo,
    assumeYes: options.assumeYes,
  });

  if (options.command === "init") {
    const written = await initialise({ repoRoot: root, run, model: options.model, name: options.name });
    console.log(
      `\n${written.path}${written.tailored ? "" : "  (generic skeleton — the agent was unreachable)"}\n` +
        `Fill it in, then:  harness run --spec ${written.path}`,
    );
    return 0;
  }

  const config = await readConfig(root);
  if (config === null) throw new Error(`${CONFIG_FILE} went missing between checks`);
  const archivedSpec = await run.archiveSpec(options.spec);

  await createBranch(branch, root);
  await run.log(`branch ${branch}`);

  let result;
  try {
    result = await runLoop({
      config,
      repoRoot: root,
      run,
      specPath: archivedSpec,
      spec: await readFile(archivedSpec, "utf8"),
      branch,
      maxAttempts: options.maxAttempts,
      model: options.model,
      specInRepo,
    });
  } finally {
    // Back to the branch the run started from, so the next run branches from
    // the same base instead of stacking on this one — and so a run leaves your
    // working state where it found it. The work is on `branch`, named below.
    await switchBranch(startedOn, root).catch(async (error: Error) => {
      await run.log(`could not return to ${startedOn}: ${error.message}`);
    });
  }

  console.log(
    `\n${result.passed ? "passed" : "failed"} after ${result.attempts} attempt(s)\n` +
      `${describeTimings(result.timings)}\n` +
      `${result.branch}\n${run.dir}`,
  );
  return result.passed ? 0 : 1;
}

/** The spec's repo-relative path, or undefined when it lives outside the repo. */
function insideRepo(root: string, spec: string): string | undefined {
  const path = relative(root, spec);
  return path === "" || path.startsWith("..") ? undefined : path;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof UsageError ? message : `harness: ${message}`);
  process.exitCode = 1;
}
