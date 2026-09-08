#!/usr/bin/env node
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createBranch, currentBranch, headCommit, repoRoot } from "./git.js";
import { Run, ensureExcluded, timestamp } from "./run.js";

const USAGE = `usage: harness run --prd <path> [--max-attempts N]

Run from inside the target repository.`;

class UsageError extends Error {}

interface Options {
  prd: string;
  maxAttempts: number;
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
        prd: { type: "string" },
        "max-attempts": { type: "string", default: "3" },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`);
  }

  if (values.prd === undefined) throw new UsageError(`--prd is required\n\n${USAGE}`);

  const maxAttempts = Number(values["max-attempts"]);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new UsageError(`--max-attempts must be a positive integer`);
  }

  return { prd: resolve(values.prd), maxAttempts };
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);

  await access(options.prd, constants.R_OK).catch(() => {
    throw new Error(`cannot read PRD: ${options.prd}`);
  });

  const root = await repoRoot(process.cwd());
  await ensureExcluded(root);

  const stamp = timestamp();
  const run = await Run.create(root, stamp);
  const branch = `harness/${stamp}`;

  await run.log(`run ${stamp}`);
  await run.log(`repo ${root}`);
  await run.log(`prd ${options.prd}`);
  await run.log(`from ${await currentBranch(root)} at ${(await headCommit(root)).slice(0, 12)}`);
  await run.log(`max-attempts ${options.maxAttempts}`);

  await createBranch(branch, root);
  await run.log(`branch ${branch}`);

  console.log(`\n${run.dir}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof UsageError ? message : `harness: ${message}`);
  process.exitCode = 1;
}
