/**
 * Picking up a run that stopped.
 *
 * Everything that matters is already on disk: each attempt is committed to the
 * run's branch and each failure is in its `feedback.json`. This finds them so
 * the next run repairs that work instead of starting from the spec.
 *
 * What does not come back is the generator's conversation — session ids are not
 * persisted, so the next attempt reads the failures rather than remembering
 * them, exactly as a fresh session after a reset does.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptFailure } from "./failure.js";
import { commitsAhead } from "./git.js";
import { ARTIFACT_DIR } from "./run.js";

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export interface Resumable {
  /** The run being continued, for saying so out loud. */
  stamp: string;
  /** Where its work is. The new run branches from here rather than from your branch. */
  branch: string;
  /** The last attempt that got far enough to report, or 0 when none did. */
  attempt: number;
  failures: AttemptFailure[];
  /** Run-relative, so a failure's evidence still resolves from the new run. */
  artifacts: string;
  /**
   * The commit that run started from (`run:started.head`), or null for a run
   * from before it was recorded. What its branch holds is measured from here.
   */
  head: string | null;
}

/**
 * The most recent run, whether or not it finished. A run that passed is as
 * resumable as one that died — continuing after a pass is how a second spec
 * builds on the first.
 *
 * `onBranch` scopes it to your work: only a run that started from that branch,
 * or produced it, is a candidate. `.harness/runs/` sits outside git and is shared
 * by every branch, so in a repo holding more than one app the newest run is
 * often another app's — found by continuing one template and nearly building on
 * a different template's code. Left undefined, every run is a candidate.
 */
export async function lastRun(
  repoRoot: string,
  excluding: string,
  onBranch?: string,
): Promise<Resumable> {
  const runs = join(repoRoot, ARTIFACT_DIR, "runs");
  // The run asking the question already has a directory — it is created before
  // this is resolved, so without excluding it the most recent run is always
  // itself, and the answer is always "that one never reached a branch".
  const entries = (await readdir(runs).catch(() => [] as string[]))
    .filter((entry) => entry !== excluding)
    .sort();
  if (entries.length === 0) throw new ResumeError(`there is no previous run in ${runs}`);

  // Backwards until one has work. A run interrupted before its branch existed
  // leaves a directory and nothing else, and there is usually one of those
  // lying around — treating the newest as the only candidate would mean a
  // single abandoned run blocked continuing until somebody tidied up.
  let newestElsewhere: { stamp: string; from: string | null; branch: string } | null = null;
  for (const stamp of entries.reverse()) {
    const dir = join(runs, stamp);
    const { from, head, branch } = await branchesOf(dir);
    if (branch === null) continue;
    if (onBranch !== undefined && from !== onBranch && branch !== onBranch) {
      newestElsewhere ??= { stamp, from, branch };
      continue;
    }

    const reported = await lastReported(dir);
    return {
      stamp,
      branch,
      attempt: reported?.attempt ?? 0,
      failures: reported?.failures ?? [],
      artifacts: join(ARTIFACT_DIR, "runs", stamp, `attempt-${reported?.attempt ?? 1}`),
      head,
    };
  }
  if (newestElsewhere !== null) {
    const { stamp, from, branch } = newestElsewhere;
    throw new ResumeError(
      `no run started from or produced ${onBranch}, so there is nothing of yours to continue. ` +
        `The newest run, ${stamp}, went from ${from ?? "an unrecorded branch"} to ${branch}: ` +
        `switch to ${from ?? branch} to continue it, or drop --continue to build on ${onBranch}.`,
    );
  }
  throw new ResumeError(
    `no run in ${runs} got as far as a branch, so there is no work to continue from`,
  );
}

/**
 * Refuses a continuation that would start from less than you already have.
 *
 * `--continue` works by switching to the run's branch, because that is where
 * its attempts were committed. Two things break that, and both break it in
 * silence. A branch that holds nothing, because the run died before committing
 * anything: the agent is handed an empty tree and writes the whole spec again.
 * And a branch behind the one you are on, because you committed the work
 * yourself after a run that could not: switching takes your commits out of the
 * tree, and the agent writes those again too. Both happened, in that order, in
 * one afternoon — the second cost an hour and rebuilt 2,475 lines in a shape
 * that no longer matched.
 *
 * Measured in git rather than read from the artifacts on purpose: a run
 * interrupted with Ctrl-C commits real work as `harness: cancelled` and never
 * writes a `feedback.json`, so "did an attempt report?" would refuse a
 * continuation that genuinely has something to continue. "Did the branch move
 * past where the run started?" is true for that run, and false only for a
 * branch that is actually empty.
 */
export async function assertContinuable(
  resuming: Resumable,
  onBranch: string,
  repoRoot: string,
): Promise<void> {
  const { stamp, branch, head } = resuming;
  // A run from before `head` was recorded keeps the old benefit of the doubt.
  if (head !== null && (await commitsAhead(head, branch, repoRoot)) === 0) {
    throw new ResumeError(
      `${stamp} committed nothing — ${branch} is still at ${head}, the commit that run started ` +
        `from. There is no work of its to continue; drop --continue to build on ${onBranch}, ` +
        `which is where anything it wrote would be.`,
    );
  }

  const dropped = await commitsAhead(branch, "HEAD", repoRoot);
  if (dropped > 0) {
    throw new ResumeError(
      `${branch} is behind ${onBranch} by ${dropped} commit(s), so continuing it would build ` +
        `without them and ask the agent for work you already have. Merge ${onBranch} into ` +
        `${branch} first, or drop --continue to build on ${onBranch} as it is.`,
    );
  }
}

/** Where a run started — the branch and the commit — and the branch it made. */
interface Ends {
  from: string | null;
  head: string | null;
  branch: string | null;
}

/** All three are already in a run's events, written before it generated anything. */
async function branchesOf(dir: string): Promise<Ends> {
  const found: Ends = { from: null, head: null, branch: null };
  const source = await readFile(join(dir, "events.jsonl"), "utf8").catch(() => null);
  if (source === null) return found;
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as { type?: string; branch?: string; from?: string; head?: string };
    if (event.type === "run:started" && typeof event.from === "string") found.from = event.from;
    if (event.type === "run:started" && typeof event.head === "string") found.head = event.head;
    if (event.type === "branch" && typeof event.branch === "string") found.branch = event.branch;
  }
  return found;
}

/**
 * The highest attempt that wrote feedback. The one after it may exist as a
 * directory and hold nothing — a run that died mid-generation leaves the shell
 * of an attempt that never reported.
 */
async function lastReported(
  dir: string,
): Promise<{ attempt: number; failures: AttemptFailure[] } | null> {
  const attempts = (await readdir(dir).catch(() => [] as string[]))
    .map((entry) => /^attempt-(\d+)$/.exec(entry)?.[1])
    .filter((number): number is string => number !== undefined)
    .map(Number)
    .sort((a, b) => b - a);

  for (const attempt of attempts) {
    const source = await readFile(join(dir, `attempt-${attempt}`, "feedback.json"), "utf8").catch(
      () => null,
    );
    if (source === null) continue;
    const feedback = JSON.parse(source) as { ok: boolean; failures: AttemptFailure[] };
    return { attempt, failures: feedback.ok ? [] : feedback.failures };
  }
  return null;
}
