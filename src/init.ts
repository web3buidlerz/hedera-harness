import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emit } from "./events.js";
import type { Run } from "./run.js";

/** Where specs live. A convention, not a requirement — `run` takes any path. */
export const SPECS_DIR = "specs";

/** See PLAN-V2 § Bounds. Reading a repo to draft one document. */
const DRAFT_TIMEOUT_MS = 5 * 60_000;
const MAX_TURNS = 30;

const TOOL = "submit_spec";

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export interface InitOptions {
  repoRoot: string;
  run: Run;
  model: string;
  /** Becomes `specs/<name>.md`. */
  name: string;
}

export interface InitResult {
  /** Repo-relative path of the spec that was written. */
  path: string;
  /** False when the agent could not be reached and the static skeleton was used. */
  tailored: boolean;
}

/**
 * Writes a spec skeleton for the operator to fill in.
 *
 * Drafted by an agent that has actually read the project, because a generic
 * skeleton cannot name the conventions a spec should follow — where pages
 * live, what the existing routes are, which hooks already exist. Unlike
 * command resolution this call is given file tools: the output is a document
 * a human edits, so there is nothing to keep reproducible.
 */
export async function initialise(options: InitOptions): Promise<InitResult> {
  const relative = join(SPECS_DIR, `${options.name}.md`);
  const target = join(options.repoRoot, relative);

  if (existsSync(target)) {
    throw new InitError(`${relative} already exists. Pick another name, or edit that one.`);
  }

  const drafted = await draft(options).catch((error: Error) => {
    emit({
      type: "note",
      level: "warn",
      text: `could not draft a tailored spec (${error.message}) — writing the skeleton`,
    });
    return null;
  });

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, drafted ?? SKELETON);
  emit({ type: "spec:written", path: relative, tailored: drafted !== null });
  return { path: relative, tailored: drafted !== null };
}

async function draft(options: InitOptions): Promise<string> {
  const captured: { markdown: string | null } = { markdown: null };

  const server = createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        TOOL,
        "Submit the spec skeleton, as markdown.",
        {
          markdown: z
            .string()
            .min(1)
            .describe("The complete spec file contents, ready to be written to disk"),
        },
        async (args) => {
          captured.markdown = args.markdown;
          return { content: [{ type: "text", text: "Written." }] };
        },
      ),
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

  try {
    const conversation = query({
      prompt: brief(options.name),
      options: {
        cwd: options.repoRoot,
        model: options.model,
        mcpServers: { harness: server },
        // Read-only: it is here to understand the project, not to change it.
        allowedTools: ["Read", "Glob", "Grep", `mcp__harness__${TOOL}`],
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        maxTurns: MAX_TURNS,
        abortController: controller,
      },
    });
    for await (const _ of conversation) {
      // Drained for the tool call; the draft arrives through the handler.
    }
  } finally {
    clearTimeout(timer);
  }

  if (captured.markdown === null) throw new InitError(`the agent finished without calling ${TOOL}`);
  return captured.markdown.endsWith("\n") ? captured.markdown : `${captured.markdown}\n`;
}

function brief(name: string): string {
  return [
    "Read enough of this project to understand what it is and how it is organised:",
    "its routes or pages, where components, hooks and utilities live, and the",
    "conventions someone adding a feature would be expected to follow.",
    "",
    `Then write a spec *skeleton* for a feature called "${name}" — a document the`,
    "developer will fill in, not a finished specification. It is read by a coding",
    "agent that will implement whatever it says, and by a second agent that will",
    "check the running app against it without being allowed to see the code.",
    "",
    "Write it so that:",
    "",
    "- headings and prompts show what to describe: what a user sees, how it behaves,",
    "  what is out of scope",
    "- placeholders are obvious and unmistakably unfilled",
    "- guidance is concrete to *this* project — name the real directories, the",
    "  existing routes, the conventions you actually found, so the developer knows",
    "  where a feature would go",
    "- it reminds the writer that anything observable should be stated in terms a",
    "  person could check in a browser, since that is how it will be judged",
    "",
    "Do not invent a feature and do not write requirements. The developer supplies",
    "the intent; you supply the shape and the local detail.",
    "",
    `Call ${TOOL} with the finished markdown.`,
  ].join("\n");
}

/** Used when the agent cannot be reached. Deliberately plain. */
const SKELETON = `# Feature name

One sentence saying what this adds and who it is for.

## What a user sees

Describe the visible result. Name routes, elements and values concretely — this
is judged by an agent driving a browser, so anything you cannot point at will
not be checked.

- [ ] ...

## Behaviour

What happens when it is used, including while loading and when something fails.

- [ ] ...

## Constraints

Anything that must or must not happen: no new dependencies, follow existing
patterns, read-only, no credentials required.

- [ ] ...

## Out of scope

What this feature deliberately does not do.
`;
