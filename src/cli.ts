#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { doctor } from "./doctor.js";
import { generate } from "./generate.js";
import { createBranch, currentBranch, headCommit, repoRoot } from "./git.js";
import { Run, ensureExcluded, timestamp } from "./run.js";
import { describeFailure, runStages } from "./test.js";

const USAGE = `usage: harness run --spec <path> [--max-attempts N] [--yes]

Run from inside the target repository.

  --spec <path>        the feature to build
  --max-attempts N    repair attempts before giving up (default 3)
  --yes               skip the first-run command confirmation`;

class UsageError extends Error {}

interface Options {
  spec: string;
  maxAttempts: number;
  assumeYes: boolean;
}

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

  return { spec: resolve(values.spec), maxAttempts, assumeYes: values.yes };
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
  await run.log(`from ${await currentBranch(root)} at ${(await headCommit(root)).slice(0, 12)}`);
  await run.log(`max-attempts ${options.maxAttempts}`);

  // DOCTOR runs before the branch exists: harness.yaml describes the project,
  // so it is committed where the project lives, not on a throwaway run branch.
  const config = await doctor({ repoRoot: root, run, assumeYes: options.assumeYes });

  await createBranch(branch, root);
  await run.log(`branch ${branch}`);

  // Phase 4: one attempt, no repair. The loop that would react to a failure
  // and call generate() again is phase 6.
  const spec = await readFile(options.spec, "utf8");
  await generate({ repoRoot: root, run, prompt: spec, attempt: 1 });

  const failure = await runStages({
    config,
    repoRoot: root,
    run,
    prefix: "attempt-1",
  });
  await run.log(failure === null ? "attempt 1 passed TEST" : `attempt 1 ${describeFailure(failure)}`);

  console.log(`\n${branch}\n${run.dir}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof UsageError ? message : `harness: ${message}`);
  process.exitCode = 1;
}
