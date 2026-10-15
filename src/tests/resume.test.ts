import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Resumable, ResumeError, assertContinuable, lastRun } from "../resume.js";
import { runCommand } from "../commands.js";

/** Builds a run directory of the shape a real run leaves behind. */
async function ranAs(
  stamp: string,
  shape: { branch?: string; attempts?: Record<number, { ok: boolean; failures: unknown[] } | null> },
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  const dir = join(repo, ".harness", "runs", stamp);
  await mkdir(dir, { recursive: true });

  const events = [{ type: "run:started", stamp }];
  if (shape.branch !== undefined) events.push({ type: "branch", branch: shape.branch } as never);
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));

  for (const [attempt, feedback] of Object.entries(shape.attempts ?? {})) {
    await mkdir(join(dir, `attempt-${attempt}`), { recursive: true });
    // null is an attempt that started and never reported — the shell a run
    // leaves when it dies mid-generation.
    if (feedback !== null) {
      await writeFile(join(dir, `attempt-${attempt}`, "feedback.json"), JSON.stringify(feedback));
    }
  }
  return repo;
}

const broke = (where: string) => ({
  kind: "verdict",
  id: "aaa111bbb222",
  where,
  what: "broken",
  evidence: ["a.png"],
});

/**
 * The case this exists for: a run that spends its last attempt and stops. Every
 * attempt is committed to its branch and every failure is in `feedback.json`,
 * and before this there was no way to use either.
 */
test("a run that died mid-attempt resumes from the last one that reported", async () => {
  const repo = await ranAs("2026-09-22T14-05-36-835Z", {
    branch: "harness/2026-09-22T14-05-36-835Z",
    attempts: {
      1: { ok: false, failures: [broke("/a")] },
      2: { ok: false, failures: [broke("/a"), broke("/b")] },
      // attempt 3 began and never reported
      3: null,
    },
  });

  const resumable = await lastRun(repo, "");
  assert.equal(resumable.branch, "harness/2026-09-22T14-05-36-835Z");
  assert.equal(resumable.attempt, 2, "attempt 3 exists as a directory and reported nothing");
  assert.equal(resumable.failures.length, 2);
  assert.match(resumable.artifacts, /attempt-2$/, "evidence must still resolve from the new run");
});

test("a run that passed carries its branch and nothing to repair", async () => {
  const repo = await ranAs("2026-09-23T00-00-00-000Z", {
    branch: "harness/passed",
    attempts: { 1: { ok: false, failures: [broke("/a")] }, 2: { ok: true, failures: [] } },
  });

  const resumable = await lastRun(repo, "");
  assert.equal(resumable.branch, "harness/passed");
  assert.deepEqual(resumable.failures, [], "a pass has nothing to start from — that is the point");
});

test("the newest run is the one continued", async () => {
  const repo = await ranAs("2026-09-01T00-00-00-000Z", {
    branch: "harness/old",
    attempts: { 1: { ok: false, failures: [broke("/a")] } },
  });
  const newer = join(repo, ".harness", "runs", "2026-09-30T00-00-00-000Z");
  await mkdir(newer, { recursive: true });
  await writeFile(
    join(newer, "events.jsonl"),
    JSON.stringify({ type: "branch", branch: "harness/new" }),
  );

  assert.equal((await lastRun(repo, "")).branch, "harness/new");
});

/**
 * An interrupted run leaves a directory and nothing else, and there is usually
 * one lying around. Taking only the newest as a candidate meant a single
 * abandoned run blocked continuing until somebody tidied up — found by killing
 * a test run and then trying to continue.
 */
test("runs that never reached a branch are stepped over", async () => {
  const repo = await ranAs("2026-09-01T00-00-00-000Z", {
    branch: "harness/real",
    attempts: { 1: { ok: false, failures: [broke("/a")] } },
  });
  for (const abandoned of ["2026-09-02T00-00-00-000Z", "2026-09-03T00-00-00-000Z"]) {
    const dir = join(repo, ".harness", "runs", abandoned);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), JSON.stringify({ type: "run:started" }));
  }

  const resumable = await lastRun(repo, "");
  assert.equal(resumable.branch, "harness/real");
  assert.equal(resumable.failures.length, 1);
});

test("nothing anywhere reached a branch, and it says so", async () => {
  const repo = await ranAs("2026-09-23T00-00-00-000Z", { attempts: {} });
  await assert.rejects(() => lastRun(repo, ""), ResumeError);
});

test("no runs at all says so, rather than failing obscurely later", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await assert.rejects(() => lastRun(repo, ""), /no previous run/);
});

/**
 * Found live rather than here: the run doing the asking already has a
 * directory, created before `--continue` is resolved. Without excluding it the
 * most recent run is always itself, and every continue reported that the
 * newest run had never reached a branch.
 */
test("a run does not continue itself", async () => {
  const repo = await ranAs("2026-09-01T00-00-00-000Z", {
    branch: "harness/real",
    attempts: { 1: { ok: false, failures: [broke("/a")] } },
  });
  const mine = join(repo, ".harness", "runs", "2026-09-30T00-00-00-000Z");
  await mkdir(mine, { recursive: true });
  await writeFile(join(mine, "events.jsonl"), JSON.stringify({ type: "run:started" }));

  const resumable = await lastRun(repo, "2026-09-30T00-00-00-000Z");
  assert.equal(resumable.branch, "harness/real");
});

/** Adds a run that started on `from` and made `branch`, to an existing repo. */
async function alsoRan(repo: string, stamp: string, from: string, branch: string): Promise<void> {
  const dir = join(repo, ".harness", "runs", stamp);
  await mkdir(join(dir, "attempt-1"), { recursive: true });
  const events = [
    { type: "run:started", stamp, from },
    { type: "branch", branch },
  ];
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  await writeFile(join(dir, "attempt-1", "feedback.json"), JSON.stringify({ ok: true, failures: [] }));
}

/**
 * The case this exists for. `.harness/runs/` is outside git and shared by every
 * branch, so in a repo holding two apps the newest run is often the other app's.
 * Found by continuing one template right after a run of a different one, and
 * nearly building the first template's features on the second's code.
 */
test("continuing takes the newest run of your branch, not the newest run", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-13T08-00-00-000Z", "templates/dvp", "harness/dvp-run");
  await alsoRan(repo, "2026-10-14T04-00-00-000Z", "templates/audit", "harness/audit-run");

  assert.equal((await lastRun(repo, "", "templates/dvp")).branch, "harness/dvp-run");
  assert.equal((await lastRun(repo, "", "templates/audit")).branch, "harness/audit-run");
});

test("standing on the branch a run made continues that run", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-13T08-00-00-000Z", "templates/dvp", "harness/dvp-run");
  await alsoRan(repo, "2026-10-14T04-00-00-000Z", "templates/audit", "harness/audit-run");

  assert.equal((await lastRun(repo, "", "harness/dvp-run")).branch, "harness/dvp-run");
});

/** A second spec built on a passed run starts from that run's branch, and continuing from there finds it. */
test("a run stacked on a harness branch is found from that branch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-13T08-00-00-000Z", "templates/dvp", "harness/dvp-run");
  await alsoRan(repo, "2026-10-14T09-00-00-000Z", "harness/dvp-run", "harness/dvp-second");

  assert.equal((await lastRun(repo, "", "harness/dvp-run")).branch, "harness/dvp-second");
});

test("with nothing of yours to continue, it names whose run is newest instead of taking it", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-14T04-00-00-000Z", "templates/audit", "harness/audit-run");

  await assert.rejects(
    () => lastRun(repo, "", "templates/bond"),
    (error: Error) =>
      error instanceof ResumeError &&
      error.message.includes("templates/bond") &&
      error.message.includes("templates/audit") &&
      error.message.includes("harness/audit-run"),
  );
});

async function sh(repo: string, command: string): Promise<string> {
  const { output } = await runCommand({ run: command }, repo, 10_000);
  return output.trim();
}

/** A repo with one commit on `main`: these checks ask git, not the artifacts. */
async function repoWithBase(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "harness-continuable-"));
  await sh(
    repo,
    "git init -q -b main && git config user.email t@t && git config user.name t" +
      " && git commit -q --allow-empty -m base",
  );
  return repo;
}

/** What `lastRun` returns for a run that went from `main` to `branch`. */
function ranFrom(head: string | null, branch: string): Resumable {
  return { stamp: "2026-10-15T15-29-45-383Z", branch, attempt: 0, failures: [], artifacts: "x", head };
}

/**
 * The first half of the afternoon this exists for. A rate limit killed
 * generation 55 minutes in; nothing was committed, so the run's branch was
 * still at the commit the run started from. Continuing it hands the agent an
 * empty tree, and it writes the whole spec again.
 */
test("a run that committed nothing is refused, not continued into an empty tree", async () => {
  const repo = await repoWithBase();
  const head = await sh(repo, "git rev-parse HEAD");
  await sh(repo, "git branch harness/run");

  await assert.rejects(
    assertContinuable(ranFrom(head, "harness/run"), "templates/bond", repo),
    (error: Error) =>
      error instanceof ResumeError &&
      /committed nothing/.test(error.message) &&
      /drop --continue/.test(error.message),
  );
});

/**
 * The second half. The work was recovered by hand onto the template branch, so
 * the run's branch was now a commit *behind* it — and continuing switched back
 * to it, taking 2,475 lines out of the tree without a word.
 */
test("a branch behind yours is refused, counting what it would drop", async () => {
  const repo = await repoWithBase();
  const head = await sh(repo, "git rev-parse HEAD");
  // The run banked an attempt, so the empty-branch check passes and this one decides.
  await sh(repo, "git switch -q -c harness/run && git commit -q --allow-empty -m 'harness: attempt 1'");
  await sh(repo, "git switch -q main && git commit -q --allow-empty -m 'feat: first iteration'");

  await assert.rejects(
    assertContinuable(ranFrom(head, "harness/run"), "main", repo),
    (error: Error) => error instanceof ResumeError && /behind main by 1 commit/.test(error.message),
  );
});

test("a branch holding the work, with nothing of yours missing, continues", async () => {
  const repo = await repoWithBase();
  const head = await sh(repo, "git rev-parse HEAD");
  await sh(repo, "git switch -q -c harness/run && git commit -q --allow-empty -m 'harness: attempt 1'");
  await sh(repo, "git switch -q main");

  await assertContinuable(ranFrom(head, "harness/run"), "main", repo);
});

/** Runs predate `run:started.head`; theirs stays continuable rather than refused. */
test("a run with no recorded head is still continuable", async () => {
  const repo = await repoWithBase();
  await sh(repo, "git branch harness/run");

  await assertContinuable(ranFrom(null, "harness/run"), "main", repo);
});
