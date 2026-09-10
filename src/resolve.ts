import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Command } from "./commands.js";
import type { HarnessConfig } from "./config.js";

const TOOL = "propose_commands";
const QUALIFIED_TOOL = `mcp__harness__${TOOL}`;
const README_BYTES = 4_000;

/** One sentence per command, written into `harness.yaml` above the line it explains. */
export interface Notes {
  install: string;
  build: string;
  test: string;
  serve: string;
}

export interface Proposal {
  config: HarnessConfig;
  notes: Notes;
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionError";
  }
}

const commandShape = z.object({
  run: z.string().min(1).describe("The command exactly as it should be run"),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Directory relative to the repo root. Omit to run at the root."),
});

/**
 * Asks the agent to read the project's manifests and say how to install, build,
 * test and serve it. Deliberately has no file tools: the context is gathered
 * here and passed in, so the same repo yields the same question every time.
 */
export async function resolveCommands(
  repoRoot: string,
  timeoutMs: number,
  model: string,
): Promise<Proposal> {
  const context = await gatherContext(repoRoot);
  const captured: { proposal: Proposal | null } = { proposal: null };

  const server = createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        TOOL,
        "Report the commands that install, build, test and serve this project.",
        {
          install: commandShape,
          build: commandShape,
          test: commandShape
            .nullable()
            .describe("null if the project genuinely has no test command"),
          serve: commandShape.describe("Starts a long-running dev server"),
          notes: z
            .object({
              install: z.string(),
              build: z.string(),
              test: z.string(),
              serve: z.string(),
            })
            .describe(
              "Why you chose each command — one short sentence each. These are written " +
                "into harness.yaml as comments, so write them for whoever reads that file " +
                "later wondering why this command and not the obvious-looking one.",
            ),
        },
        async (args) => {
          captured.proposal = {
            config: {
              install: args.install as Command,
              build: args.build as Command,
              test: args.test as Command | null,
              serve: args.serve as Command,
            },
            notes: args.notes as Notes,
          };
          return { content: [{ type: "text", text: "Recorded." }] };
        },
      ),
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const transcript: string[] = [];

  try {
    const conversation = query({
      prompt: buildPrompt(context),
      options: {
        cwd: repoRoot,
        model,
        mcpServers: { harness: server },
        allowedTools: [QUALIFIED_TOOL],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 4,
        abortController: controller,
        systemPrompt:
          "You identify how to build and run a JavaScript project from its manifests. " +
          "You answer only by calling the propose_commands tool.",
      },
    });

    for await (const message of conversation) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") transcript.push(block.text);
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ResolutionError(`command resolution timed out after ${timeoutMs / 1000}s`);
    }
    throw new ResolutionError((error as Error).message);
  } finally {
    clearTimeout(timer);
  }

  if (captured.proposal === null) {
    const said = transcript.join(" ").trim().slice(0, 400);
    throw new ResolutionError(
      `the agent finished without calling ${TOOL}${said ? `. It said: ${said}` : ""}`,
    );
  }
  return captured.proposal;
}

interface Context {
  packageManager: string;
  manifests: Array<{ path: string; source: string }>;
  readme: string | null;
}

function buildPrompt(context: Context): string {
  const manifests = context.manifests
    .map(({ path, source }) => `--- ${path}\n${source}`)
    .join("\n\n");

  return [
    `Package manager: ${context.packageManager}`,
    "",
    manifests,
    context.readme ? `\n--- README (truncated)\n${context.readme}` : "",
    "",
    "Identify four commands for this project: install, build, test, serve.",
    "",
    "Script names in these projects are frequently misleading. A root package.json",
    "may have no build/test/dev script at all while the real ones are namespaced",
    "per workspace, and a workspace may define `start` as a dev server while",
    "`serve` runs the production build. Read what each script actually does",
    "rather than matching on its name.",
    "",
    "Rules:",
    "- Prefer a command runnable from the repo root; set cwd only when necessary.",
    "- build must produce a production build. serve must start a dev server that",
    "  keeps running and serves the app locally.",
    "- test is null only if the project genuinely has no way to run tests.",
    "",
    `Call ${TOOL} with your answer.`,
  ].join("\n");
}

async function gatherContext(repoRoot: string): Promise<Context> {
  const rootSource = await readFile(join(repoRoot, "package.json"), "utf8").catch(() => null);
  if (rootSource === null) {
    throw new ResolutionError("no package.json at the repo root — this is not a node project");
  }

  const manifests = [{ path: "package.json", source: rootSource }];
  for (const relative of await workspaceManifests(repoRoot, rootSource)) {
    const source = await readFile(join(repoRoot, relative), "utf8").catch(() => null);
    if (source !== null) manifests.push({ path: relative, source });
  }

  const readme = await readFile(join(repoRoot, "README.md"), "utf8")
    .then((text) => text.slice(0, README_BYTES))
    .catch(() => null);

  return { packageManager: await detectPackageManager(repoRoot), manifests, readme };
}

async function detectPackageManager(repoRoot: string): Promise<string> {
  const lockfiles: Record<string, string> = {
    "yarn.lock": "yarn",
    "pnpm-lock.yaml": "pnpm",
    "bun.lockb": "bun",
    "package-lock.json": "npm",
  };
  for (const [file, manager] of Object.entries(lockfiles)) {
    const found = await readFile(join(repoRoot, file), "utf8").then(
      () => true,
      () => false,
    );
    if (found) return manager;
  }
  return "npm (no lockfile found)";
}

/** Expands the `workspaces` field far enough to find each member's package.json. */
async function workspaceManifests(repoRoot: string, rootSource: string): Promise<string[]> {
  let patterns: string[] = [];
  try {
    const root = JSON.parse(rootSource) as {
      workspaces?: string[] | { packages?: string[] };
    };
    patterns = Array.isArray(root.workspaces)
      ? root.workspaces
      : (root.workspaces?.packages ?? []);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      found.push(join(pattern, "package.json"));
      continue;
    }
    const parent = dirname(pattern);
    const entries = await readdir(join(repoRoot, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) found.push(join(parent, entry.name, "package.json"));
    }
  }
  return found;
}
