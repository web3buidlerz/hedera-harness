#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, readConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { initialise } from "./init.js";
import { runLoop } from "./loop.js";
import { killTrackedChildren } from "./commands.js";
import { commitWork, createBranch, currentBranch, headCommit, repoRoot, switchBranch } from "./git.js";
import { Run, ensureExcluded, timestamp } from "./run.js";
import { type Timings, emit } from "./events.js";
import { renderToJson } from "./render/json.js";
import { renderToLog } from "./render/log.js";
import { renderToTerminal } from "./render/terminal.js";
import { red } from "./style.js";

const USAGE = `usage: harness init [name] [--model NAME] [--yes]
       harness run --spec <path> [--max-attempts N] [--model NAME] [--yes] [--json]

Run from inside the target repository.

  init [name]         set the project up: work out its commands, and draft
                      specs/<name>.md for you to fill in (default: feature)
  run --spec <path>   build the feature described by a spec

  --spec <path>        the feature to build
  --max-attempts N    repair attempts before giving up (default 3)
  --model NAME        agent model: sonnet (default), opus, haiku, or a full id
  --yes               skip the first-run command confirmation
  --json              one JSON object per line instead of the watchable output`;

class UsageError extends Error {}

/**
 * What an interrupt needs in order to leave things tidy. Filled in as the run
 * acquires it, so a Ctrl-C before the branch exists still kills any children.
 */
interface Interruptible {
  repoRoot?: string;
  run?: Run;
  branch?: string;
  startedOn?: string;
  specInRepo?: string | undefined;
}

const context: Interruptible = {};
let interrupting = false;

/** A cancelled run has no per-stage total worth reporting; the renderer omits it. */
const NO_TIMINGS: Timings = { generateMs: 0, testMs: 0, evaluateMs: 0 };

/**
 * Ctrl-C used to tear the process down without unwinding the `finally` blocks
 * that stop the dev server and return you to your branch — leaving a server
 * holding the port and a dirty tree on a harness branch, which is exactly the
 * state that makes the next run refuse to start.
 *
 * The attempt is committed rather than discarded, for the same reason every
 * other attempt is: a clean tree is what lets you run again, and the work is
 * on a throwaway branch you can delete.
 */
async function cancel(): Promise<never> {
  killTrackedChildren();

  const { repoRoot, run, startedOn, branch } = context;
  if (repoRoot !== undefined) {
    await commitWork(
      "harness: cancelled",
      repoRoot,
      context.specInRepo === undefined ? [] : [context.specInRepo],
    ).catch(() => null);
    if (startedOn !== undefined) await switchBranch(startedOn, repoRoot).catch(() => undefined);
  }
  if (run !== undefined) {
    await run.writeResult({ passed: false, cancelled: true, branch: branch ?? null }).catch(
      () => undefined,
    );
    emit({
      type: "run:finished",
      passed: false,
      cancelled: true,
      attempts: 0,
      branch: branch ?? null,
      timings: NO_TIMINGS,
      dir: run.dir,
    });
  }
  process.exit(130);
}

function onInterrupt(): void {
  if (interrupting) process.exit(130);
  interrupting = true;
  emit({ type: "note", level: "warn", text: "interrupted — cleaning up (Ctrl-C again to quit now)" });
  void cancel();
}

type Command = "init" | "run";

interface Options {
  command: Command;
  /** `init`'s optional name, becoming `specs/<name>.md`. */
  name: string;
  spec: string;
  maxAttempts: number;
  model: string;
  assumeYes: boolean;
  json: boolean;
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
        json: { type: "boolean", default: false },
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
    json: values.json,
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
  context.repoRoot = root;
  await ensureExcluded(root);

  const stamp = timestamp();
  const run = await Run.create(root, stamp);
  const branch = `harness/${stamp}`;
  context.run = run;

  // Renderers attach before the first event, and the log one needs the run
  // directory — which is why `Run.create` comes first.
  renderToLog(run.dir);
  if (options.json) renderToJson();
  else renderToTerminal();

  const startedOn = await currentBranch(root);
  context.startedOn = startedOn;
  const specInRepoPath = options.command === "run" ? insideRepo(root, options.spec) : undefined;
  emit({
    type: "run:started",
    command: options.command,
    stamp,
    repo: root,
    spec: options.command === "run" ? options.spec : undefined,
    specInRepo: specInRepoPath,
    from: startedOn,
    head: (await headCommit(root)).slice(0, 12),
    model: options.model,
    maxAttempts: options.maxAttempts,
  });

  // DOCTOR runs before the branch exists: harness.yaml describes the project,
  // so it is committed where the project lives, not on a throwaway run branch.
  const specInRepo = specInRepoPath;
  context.specInRepo = specInRepo;

  await doctor({
    repoRoot: root,
    run,
    model: options.model,
    specPath: specInRepo,
    assumeYes: options.assumeYes,
  });

  if (options.command === "init") {
    await initialise({ repoRoot: root, run, model: options.model, name: options.name });
    return 0;
  }

  const config = await readConfig(root);
  if (config === null) throw new Error(`${CONFIG_FILE} went missing between checks`);
  const archivedSpec = await run.archiveSpec(options.spec);

  await createBranch(branch, root);
  context.branch = branch;
  emit({ type: "branch", branch });

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
    await switchBranch(startedOn, root).catch((error: Error) => {
      emit({ type: "note", level: "warn", text: `could not return to ${startedOn}: ${error.message}` });
    });
  }

  emit({
    type: "run:finished",
    passed: result.passed,
    cancelled: false,
    attempts: result.attempts,
    branch: result.branch,
    timings: result.timings,
    dir: run.dir,
  });
  return result.passed ? 0 : 1;
}

/** The spec's repo-relative path, or undefined when it lives outside the repo. */
function insideRepo(root: string, spec: string): string | undefined {
  const path = relative(root, spec);
  return path === "" || path.startsWith("..") ? undefined : path;
}

process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof UsageError ? message : `${red("harness:")} ${message}`);
  process.exitCode = 1;
}
