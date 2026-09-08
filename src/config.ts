import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Command } from "./commands.js";

/** Committed, not ignored: it describes the project, not a run. */
export const CONFIG_FILE = "harness.yaml";

/** A command is either a bare string or `{ run, cwd }` with `cwd` relative to the repo root. */
const commandSchema = z
  .union([
    z.string().min(1),
    z.object({ run: z.string().min(1), cwd: z.string().min(1).optional() }),
  ])
  .transform((value): Command => (typeof value === "string" ? { run: value } : value));

export const configSchema = z.object({
  install: commandSchema,
  build: commandSchema,
  /** Absent or null when the repo has no test script. `build` has no such escape. */
  test: commandSchema.nullable().default(null),
  serve: commandSchema,
});

export type HarnessConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(path: string, detail: string) {
    super(`${path} is not valid: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Returns null when the file does not exist — the signal for a first run. */
export async function readConfig(repoRoot: string): Promise<HarnessConfig | null> {
  const path = join(repoRoot, CONFIG_FILE);
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) return null;

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ConfigError(CONFIG_FILE, (error as Error).message);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(CONFIG_FILE, detail);
  }
  return parsed.data;
}

export async function writeConfig(repoRoot: string, config: HarnessConfig): Promise<void> {
  const body = stringify(
    {
      install: flatten(config.install),
      build: flatten(config.build),
      test: config.test === null ? null : flatten(config.test),
      serve: flatten(config.serve),
    },
    { lineWidth: 0 },
  );
  await writeFile(join(repoRoot, CONFIG_FILE), body);
}

/** Writes `yarn install` rather than `{ run: yarn install }` when there is no cwd. */
function flatten(command: Command): string | Command {
  return command.cwd === undefined ? command.run : command;
}
