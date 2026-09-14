#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { doctor } from "./doctor.js";
import { describeTimings, runLoop } from "./loop.js";
import { createBranch, currentBranch, headCommit, repoRoot, switchBranch } from "./git.js";
import { Run, ensureExcluded, timestamp } from "./run.js";

const USAGE = `usage: harness run --spec <path> [--max-attempts N] [--yes]

Run from inside the target repository.

  --spec <path>        the feature to build
  --max-attempts N    repair attempts before giving up (default 3)
  --model NAME        agent model: sonnet (default), opus, haiku, or a full id
  --yes               skip the first-run command confirmation`;

class UsageError extends Error {}

interface Options {
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
  if (command !== "run") throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);

  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
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

  if (values.spec === undefined) throw new UsageError(`--spec is required\n\n${USAGE}`);

  const maxAttempts = Number(values["max-attempts"]);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new UsageError(`--max-attempts must be a positive integer`);
  }

  return { spec: resolve(values.spec), maxAttempts, model: values.model, assumeYes: values.yes };
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);

  await access(options.spec, constants.R_OK).catch(() => {
    throw new Error(`cannot read spec: ${options.spec}`);
  });

  const root = await repoRoot(process.cwd());
  await ensureExcluded(root);

  const stamp = timestamp();
  const run = await Run.create(root, stamp);
  const branch = `harness/${stamp}`;

  await run.log(`run ${stamp}`);
  await run.log(`repo ${root}`);
  await run.log(`spec ${options.spec}`);
  const archivedSpec = await run.archiveSpec(options.spec);
  const startedOn = await currentBranch(root);
  await run.log(`from ${startedOn} at ${(await headCommit(root)).slice(0, 12)}`);
  await run.log(`max-attempts ${options.maxAttempts}, model ${options.model}`);

  // DOCTOR runs before the branch exists: harness.yaml describes the project,
  // so it is committed where the project lives, not on a throwaway run branch.
  const specInRepo = insideRepo(root, options.spec);
  const config = await doctor({
    repoRoot: root,
    run,
    model: options.model,
    specPath: specInRepo,
    assumeYes: options.assumeYes,
  });

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
