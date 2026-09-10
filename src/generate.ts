import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Run } from "./run.js";

/** See PLAN-V2 § Bounds. Starting points, to be tuned once there are real runs. */
const WALL_CLOCK_MS = 60 * 60_000;
const MAX_TURNS = 300;
const MAX_BUDGET_USD = 10;

/** Where the Hedera skill plugins live. Machine config, so an env var, not `harness.yaml`. */
const SKILLS_DIR = process.env["HEDERA_SKILLS_DIR"] ?? join(homedir(), "Work/hedera-skills/plugins");

export class GenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateError";
  }
}

export interface GenerateOptions {
  repoRoot: string;
  run: Run;
  /** The spec on a first attempt; the failure to repair on any attempt after. */
  prompt: string;
  attempt: number;
  model: string;
  /** Continue the previous attempt's conversation. Omitted after a reset. */
  resume?: string | undefined;
}

export interface GenerateResult {
  /** Pass back as `resume` so the next attempt keeps its context. */
  sessionId: string | undefined;
  turns: number;
  costUsd: number | undefined;
}

/**
 * Lets the agent implement the spec in the repo. Everything about *how* —
 * which files to touch, which skills to read, whether to write tests — is
 * the agent's call. The harness only bounds it and records what happened.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { repoRoot, run, attempt } = options;
  const transcript = await run.path(`attempt-${attempt}`, "generate.jsonl");
  const plugins = await discoverPlugins();

  await run.log(
    plugins.length === 0
      ? `generate attempt ${attempt} (no skill plugins at ${SKILLS_DIR})`
      : `generate attempt ${attempt} with ${plugins.length} skill plugins`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WALL_CLOCK_MS);

  let sessionId: string | undefined;
  let turns = 0;
  let costUsd: number | undefined;

  try {
    const conversation = query({
      prompt: options.prompt,
      options: {
        cwd: repoRoot,
        model: options.model,
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        plugins: plugins.map((path) => ({ type: "local" as const, path })),
        // The repo's own CLAUDE.md is worth having; the operator's personal
        // settings are not — a run should not depend on who launched it.
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        hooks: { PreToolUse: [{ hooks: [guard] }] },
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        abortController: controller,
      },
    });

    // Absent means the CLI did not report on it; false means a plugin we asked
    // for is not loaded, which would generate silently skill-less.
    const initialized = await conversation.initializationResult();
    if (plugins.length > 0 && initialized.plugins_applied === false) {
      controller.abort();
      throw new GenerateError(
        `the CLI did not load every skill plugin from ${SKILLS_DIR}. ` +
          `Generating without them would silently produce worse code.`,
      );
    }

    for await (const message of conversation) {
      await appendFile(transcript, `${JSON.stringify(message)}\n`);
      sessionId ??= message.session_id;
      if (message.type === "assistant") turns += 1;
      if (message.type === "result") {
        costUsd = (message as { total_cost_usd?: number }).total_cost_usd;
      }
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof GenerateError)) {
      throw new GenerateError(
        `the agent did not finish within ${WALL_CLOCK_MS / 60_000} minutes`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  await run.log(
    `generate attempt ${attempt} done — ${turns} turns` +
      (costUsd === undefined ? "" : `, $${costUsd.toFixed(2)}`),
  );
  return { sessionId, turns, costUsd };
}

/** Every immediate subdirectory of the skills directory is offered as a plugin. */
async function discoverPlugins(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(SKILLS_DIR, entry.name))
    .sort();
}

/** Any reference to a dotenv file, as a path or as a bare token in a command. */
const ENV_REFERENCE = /(?:^|[\s/'"=])(\.env(?:\.[\w-]+)?)(?=$|[\s'";&|)<>])/g;

/** Templates carry no secrets, and this is where the agent is told to put new variables. */
const TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/;

/**
 * The same file named inside a shell command rather than as a path — `> .env`,
 * `tee ./.env.local`. Denying the `Write` tool alone is not enough: an agent
 * refused there reaches for Bash next, which is what it did the first time
 * this hook was tested.
 */
const WRITES_TO_FILE = />>?\s*['"]?[^\s'"|;&()]*\.env|\b(tee|cp|mv|install|dd|ln)\b/;

const IRREVERSIBLE_GIT = /\bgit\b[^\n]*\b(push\s+(-f\b|--force\b)|filter-branch\b|--force-with-lease\b)/;

/**
 * The one thing throwing away a branch cannot undo is a committed secret, so
 * `.env*` writes are refused outright, along with git commands that rewrite
 * published history. Everything else is allowed to fail loudly instead.
 */
/** Exported for tests: the deny decision, without a live agent. */
export async function guard(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) {
  const reason = refusalReason(input.tool_name ?? "", input.tool_input);
  if (reason === null) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function refusalReason(toolName: string, toolInput: unknown): string | null {
  const input = (toolInput ?? {}) as { file_path?: string; command?: string };

  if (typeof input.file_path === "string") {
    const secret = secretsNamed(input.file_path);
    if (secret !== null) return refusal(`${toolName} to ${input.file_path}`);
  }

  if (typeof input.command === "string") {
    if (WRITES_TO_FILE.test(input.command)) {
      const secret = secretsNamed(input.command);
      if (secret !== null) return refusal(`writing to ${secret}`);
    }
    if (IRREVERSIBLE_GIT.test(input.command)) {
      return "rewriting published git history is refused; the run works on its own branch.";
    }
  }
  return null;
}

/** The first dotenv file named here that is not a template, or null. */
function secretsNamed(text: string): string | null {
  for (const [, name] of text.matchAll(ENV_REFERENCE)) {
    if (name !== undefined && !TEMPLATE.test(name)) return name;
  }
  return null;
}

function refusal(what: string): string {
  return (
    `${what} is refused: dotenv files hold real credentials, and a committed secret ` +
    `survives deleting the branch. Reading one is fine. To record a new variable, ` +
    `write .env.example instead — that is allowed.`
  );
}
