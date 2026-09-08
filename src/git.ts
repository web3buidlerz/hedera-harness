import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A git invocation that failed, carrying git's own stderr rather than node's wrapper text. */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")}: ${stderr.trim() || "failed"}`);
    this.name = "GitError";
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new GitError(args, stderr);
  }
}

/**
 * Absolute path to the repository containing `cwd`.
 * Throws if `cwd` is not inside a work tree — the harness always runs from a repo.
 */
export async function repoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export async function headCommit(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd);
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/** True when nothing is staged, modified or untracked. */
export async function isClean(cwd: string): Promise<boolean> {
  return (await git(["status", "--porcelain"], cwd)) === "";
}

/**
 * True when `path` is tracked. Ignore rules never apply to tracked files, so a
 * tracked `.harness/` cannot be excluded and would fail the clean check forever.
 */
export async function isTracked(path: string, cwd: string): Promise<boolean> {
  return (await git(["ls-files", "--", path], cwd)) !== "";
}

/** Creates `name` from the current commit and switches to it. */
export async function createBranch(name: string, cwd: string): Promise<void> {
  await git(["switch", "--create", name], cwd);
}

/** Stages `paths` and commits them. Nothing else in the tree is touched. */
export async function commit(paths: string[], message: string, cwd: string): Promise<void> {
  await git(["add", "--", ...paths], cwd);
  await git(["commit", "--message", message, "--", ...paths], cwd);
}
