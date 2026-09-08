import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTracked } from "./git.js";

/** Everything the harness writes lives here, and it is git-excluded. */
export const ARTIFACT_DIR = ".harness";

const EXCLUDE_ENTRY = `${ARTIFACT_DIR}/`;
const EXCLUDE_FILE = join(".git", "info", "exclude");

/** `2026-09-08T13-26-04-871Z` — sorts chronologically and is safe in a path or a branch name. */
export function timestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export class TrackedArtifactsError extends Error {
  constructor() {
    super(
      `${EXCLUDE_ENTRY} is tracked by git. Ignore rules do not apply to tracked ` +
        `files, so the harness cannot keep its output out of your history. ` +
        `Remove it with: git rm -r --cached ${ARTIFACT_DIR}`,
    );
    this.name = "TrackedArtifactsError";
  }
}

/**
 * Adds `.harness/` to `.git/info/exclude`, which is per-clone and untracked — so
 * the harness never dirties the repo and never edits a file the user owns.
 * Idempotent, and self-healing if the entry is removed.
 */
export async function ensureExcluded(repoRoot: string): Promise<void> {
  if (await isTracked(ARTIFACT_DIR, repoRoot)) throw new TrackedArtifactsError();

  const path = join(repoRoot, EXCLUDE_FILE);
  const current = await readFile(path, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === EXCLUDE_ENTRY)) return;

  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}${EXCLUDE_ENTRY}\n`);
}

/** One run's directory, and the log every stage transition appends to. */
export class Run {
  private constructor(
    readonly dir: string,
    readonly timestamp: string,
  ) {}

  static async create(repoRoot: string, stamp = timestamp()): Promise<Run> {
    const dir = join(repoRoot, ARTIFACT_DIR, "runs", stamp);
    await mkdir(dir, { recursive: true });
    return new Run(dir, stamp);
  }

  /** Appends one timestamped line to `harness.log` and echoes it to stdout. */
  async log(message: string): Promise<void> {
    const line = `${new Date().toISOString()} ${message}`;
    await appendFile(join(this.dir, "harness.log"), `${line}\n`);
    console.log(message);
  }

  /** Path inside this run's directory, creating parent directories as needed. */
  async path(...segments: string[]): Promise<string> {
    const target = join(this.dir, ...segments);
    await mkdir(join(target, ".."), { recursive: true });
    return target;
  }

  async writeResult(result: unknown): Promise<void> {
    await writeFile(join(this.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
}
