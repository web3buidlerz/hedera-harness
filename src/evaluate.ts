import { appendFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emit } from "./events.js";
import { describeMessage, endingOf } from "./messages.js";
import type { Run } from "./run.js";

/** See PLAN-V2 § Bounds — shorter than GENERATE: judging is cheaper than building. */
const WALL_CLOCK_MS = 20 * 60_000;
// Loosened from 120 after measuring: at 4x the busiest real evaluation this was
// the tightest bound in the harness, on specs that have all been small. Turns
// are the last line of defence, not the first — they exist to stop a cheap
// endless loop that spend and wall clock would take far too long to catch, so
// the other two should bind first in any normal run.
const MAX_TURNS = 300;
const MAX_BUDGET_USD = 5;

const TOOL = "submit_verdict";
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Failure {
  what: string;
  where: string;
  evidence: string[];
}

export interface Verdict {
  pass: boolean;
  failures: Failure[];
}

/**
 * Either the evaluator answered, or it did not. There is no third state: a
 * well-formed verdict is final and is never re-rolled, while "no verdict"
 * means exactly the three cases below and earns one retry.
 */
export type Outcome =
  | { type: "verdict"; verdict: Verdict }
  | { type: "no-verdict"; reason: string };

export interface EvaluateOptions {
  repoRoot: string;
  run: Run;
  specPath: string;
  attempt: number;
  model: string;
  appUrl: string;
}

const failureShape = z.object({
  what: z.string().min(1).describe("What a user cannot do, in their terms"),
  /**
   * Kept to a bare locator on purpose. The harness hashes this to tell a
   * repeated failure from a new one across attempts, and a fresh evaluator
   * each attempt words prose differently every time — two runs describing
   * one bug would look like two bugs.
   */
  where: z
    .string()
    .min(1)
    .describe(
      "Where it happens, as a bare locator and nothing else: a route like " +
        "`/?n=5`, or a selector like `#result`. No sentences, no explanation.",
    ),
  /**
   * A list rather than a string, because a single field invites prose: the
   * first evaluator to fail a spec answered with a filename followed by a
   * parenthesised explanation, and the whole thing was read as a path.
   * Explanation belongs in `what`; this field holds only references.
   */
  evidence: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "One entry per piece of evidence, each either a filename you saved in " +
        "evidence/ or a mirror node URL. Nothing else — no sentences, no notes " +
        "in brackets. Put the explanation in `what`.",
    ),
});

/**
 * Judges the running app against the spec, from a directory that holds only
 * the spec. The evaluator never sees the code, the diff, or this harness —
 * enforcement is the sandbox plus a read deny on the repo, not the prompt.
 *
 * A fresh evaluator every attempt, deliberately: one that remembered its own
 * previous findings would re-check those and wave the rest through, arriving
 * already expecting a broken app.
 */
export async function evaluate(options: EvaluateOptions): Promise<Outcome> {
  const { run, attempt, appUrl } = options;

  const workspace = await mkdtemp(join(tmpdir(), "harness-eval-"));
  await mkdir(join(workspace, "evidence"));
  await cp(options.specPath, join(workspace, "spec.md"));

  const captured: Captured = { verdict: null, malformed: null };
  const server = verdictServer(captured);
  const transcript = await run.path(`attempt-${attempt}`, "evaluate.jsonl");

  emit({
    type: "phase:started",
    phase: "evaluate",
    attempt,
    detail: `${options.model} · blind · ${appUrl}`,
  });

  let { outcome, sessionId } = await pass(options, workspace, server, transcript, {
    prompt: brief(appUrl, hedera()),
    captured,
  });

  if (outcome.type === "no-verdict") {
    // Resumed, not restarted: a fresh evaluator re-opens the browser, re-reads
    // the chain and re-runs every wait, which on the one real occurrence
    // repeated 28 tool calls. It does not weaken "a verdict is never
    // re-rolled" — that rule stops an evaluator diffing against its own
    // previous verdict, and here there is none.
    emit({
      type: "note",
      level: "warn",
      text: `no verdict (${outcome.reason}) — asking the same evaluator to finish`,
    });
    captured.malformed = null;
    ({ outcome } = await pass(options, workspace, server, transcript, {
      prompt: nudge(outcome.reason),
      captured,
      resume: sessionId,
    }));
    if (outcome.type === "no-verdict") {
      outcome = { type: "no-verdict", reason: `${outcome.reason} (asked twice)` };
    }
  }

  // Evidence is collected whatever the outcome — a run that produced no verdict
  // is exactly when you want to see what the evaluator was looking at.
  await cp(join(workspace, "evidence"), await run.path(`attempt-${attempt}`, "evidence"), {
    recursive: true,
  });

  if (outcome.type === "verdict") {
    await writeFile(
      await run.path(`attempt-${attempt}`, "verdict.json"),
      `${JSON.stringify(outcome.verdict, null, 2)}\n`,
    );
  }
  return outcome;
}

interface Captured {
  verdict: Verdict | null;
  malformed: string | null;
}

/**
 * One turn of the evaluator, bounded on its own. Returns what the harness makes
 * of it — a verdict, or one of the three ways there is not one.
 */
async function pass(
  options: EvaluateOptions,
  workspace: string,
  server: ReturnType<typeof createSdkMcpServer>,
  transcript: string,
  turn: { prompt: string; captured: Captured; resume?: string | undefined },
): Promise<{ outcome: Outcome; sessionId: string | undefined }> {
  const { repoRoot, attempt } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WALL_CLOCK_MS);
  const startedAt = Date.now();
  let costUsd: number | undefined;
  let sessionId: string | undefined;

  // The agent's Bash resolves `playwright-cli` from the harness's own install,
  // so the target repo does not have to depend on it.
  const previousPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${join(HARNESS_ROOT, "node_modules", ".bin")}:${previousPath}`;

  try {
    const conversation = query({
      prompt: turn.prompt,
      options: {
        cwd: workspace,
        model: options.model,
        ...(turn.resume === undefined ? {} : { resume: turn.resume }),
        plugins: [{ type: "local", path: playwrightSkills() }],
        mcpServers: { harness: server },
        settingSources: [],
        permissionMode: "bypassPermissions",
        sandbox: {
          enabled: true,
          // A missing seatbelt or bubblewrap must abort, never silently
          // downgrade to an unsandboxed evaluator.
          failIfUnavailable: true,
          filesystem: { denyRead: [repoRoot, HARNESS_ROOT] },
        },
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        abortController: controller,
      },
    });

    for await (const message of conversation) {
      await appendFile(transcript, `${JSON.stringify(message)}\n`);
      const step = describeMessage(message);
      if (step !== null) emit({ type: "tool", tool: step.tool, argument: step.argument });
      sessionId ??= message.session_id;
      // A bound the SDK enforces itself arrives as an error result and *then*
      // throws when the iterator is pulled again. Reading it here is what turns
      // "the run died" into "no verdict, ask once more", which is what the
      // bounds table always said it was.
      const ending = endingOf(message, MAX_TURNS);
      if (ending !== null) {
        costUsd = ending.costUsd;
        if (ending.failure !== null) turn.captured.malformed = `the evaluator stopped because ${ending.failure}`;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      turn.captured.malformed = `the evaluator did not finish within ${WALL_CLOCK_MS / 60_000} minutes`;
    } else if (turn.captured.malformed === null) {
      throw error;
    }
    // Otherwise the stream already said why it stopped, and the throw is the
    // same news arriving twice.
  } finally {
    clearTimeout(timer);
    process.env["PATH"] = previousPath;
  }

  const outcome = adjudicate(turn.captured, workspace);
  emit({
    type: "evaluate:finished",
    attempt,
    verdict: outcome.type === "no-verdict" ? "none" : outcome.verdict.pass ? "pass" : "fail",
    findings: outcome.type === "no-verdict" ? 0 : outcome.verdict.failures.length,
    costUsd,
    durationMs: Date.now() - startedAt,
  });
  return { outcome, sessionId };
}

function verdictServer(captured: Captured): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        TOOL,
        "Report whether the running app satisfies the spec. Call this exactly once, at the end.",
        {
          pass: z.boolean().describe("true only if every requirement in the spec is met"),
          failures: z
            .array(failureShape)
            .describe("Empty when passing. One entry per requirement that is not met."),
        },
        async (args) => {
          captured.verdict = { pass: args.pass, failures: args.failures as Failure[] };
          // Answering ends the turn. Without this the evaluator decides for
          // itself when it is finished, and the one time it got that wrong it
          // ended without answering at all.
          return {
            content: [{ type: "text", text: "Verdict recorded." }],
            _meta: { "claude/endTurn": true },
          };
        },
      ),
    ],
  });
}

/**
 * What the harness says when it intervenes. The evaluator that produced no
 * verdict on the one real occurrence had not failed or got stuck — it had
 * backgrounded a timer and ended its turn expecting to be woken, which is
 * correct behaviour in an interactive session and fatal in this one.
 */
function nudge(reason: string): string {
  return [
    `Your turn ended without a usable verdict: ${reason}`,
    "",
    "Nothing resumed you automatically — this message is the harness intervening,",
    "and it is the last turn you get. Do not start anything in the background and",
    "do not wait to be notified. If you still need to observe something, do it now",
    "with a command that blocks until it is finished.",
    "",
    `Then call ${TOOL}. You already have the evidence you gathered in evidence/.`,
  ].join("\n");
}

/**
 * The three ways there is no verdict: the evaluator never called the tool,
 * the payload was not usable, or it cited evidence that is not on disk.
 * Anything else the evaluator says is an answer, and answers stand.
 */
function adjudicate(
  captured: { verdict: Verdict | null; malformed: string | null },
  workspace: string,
): Outcome {
  if (captured.malformed !== null) return { type: "no-verdict", reason: captured.malformed };
  if (captured.verdict === null) {
    return { type: "no-verdict", reason: `the evaluator finished without calling ${TOOL}` };
  }

  const missing = captured.verdict.failures
    .flatMap((failure) => failure.evidence)
    .filter((evidence) => !resolves(evidence, workspace));

  if (missing.length > 0) {
    return {
      type: "no-verdict",
      reason:
        `the verdict cites evidence that is not there: ${missing.join(", ")}. ` +
        `A finding the harness cannot see is not a finding.`,
    };
  }
  return { type: "verdict", verdict: captured.verdict };
}

/**
 * Evidence is a file the evaluator saved, or a URL it read. Both must be
 * checkable. A relative name is tried against the workspace and against
 * `evidence/` — the agent writes `evidence/shot.png` as often as `shot.png`,
 * and rejecting a real file over which prefix it used would be pedantry
 * indistinguishable from the check that matters.
 */
function resolves(evidence: string, workspace: string): boolean {
  if (/^https?:\/\//.test(evidence)) return true;
  if (isAbsolute(evidence)) return existsSync(evidence);
  return (
    existsSync(join(workspace, evidence)) || existsSync(join(workspace, "evidence", evidence))
  );
}

interface Hedera {
  network: string;
  mirrorNode: string;
  accounts: string[];
}

/** Mirror node reads are public, so the evaluator is told where to look and never a key. */
function hedera(): Hedera {
  const network = process.env["HEDERA_NETWORK"] ?? "testnet";
  const mirrorNode =
    process.env["HEDERA_MIRROR_NODE"] ??
    (network === "mainnet"
      ? "https://mainnet-public.mirrornode.hedera.com"
      : `https://${network}.mirrornode.hedera.com`);
  const operator = process.env["HEDERA_OPERATOR_ID"];
  return { network, mirrorNode, accounts: operator === undefined ? [] : [operator] };
}

function brief(appUrl: string, chain: Hedera): string {
  return [
    "You are checking whether a running web application does what its spec says.",
    "",
    `The app is running at ${appUrl}.`,
    `It is built on Hedera ${chain.network}; the public mirror node is ${chain.mirrorNode}.`,
    chain.accounts.length > 0
      ? `Transactions it makes come from account ${chain.accounts.join(", ")}.`
      : "",
    "",
    "Read spec.md, which is the only file here. Decide what a user should be able",
    "to do if the spec were satisfied, then try it against the running app:",
    "",
    "- drive the browser with `playwright-cli` through Bash (see the playwright-cli skill)",
    "- check any on-chain effect by reading the mirror node over HTTP; it is public,",
    "  and you have no keys and need none",
    "- save a screenshot, page snapshot or saved response into `evidence/` **as you go**,",
    "  so every finding can be checked afterwards",
    "",
    "You cannot see the source code and should not try; judge only observable behaviour.",
    "",
    "**You get one turn and nothing will resume you.** Never start a command in the",
    "background and end your turn waiting to be notified — no notification can arrive,",
    "and a turn that ends without a verdict throws the whole evaluation away. If you",
    "need to wait, wait in the foreground: a blocking command costs nothing while it",
    `runs, and you have ${WALL_CLOCK_MS / 60_000} minutes for the entire check.`,
    "",
    `When you are done, call ${TOOL} exactly once. Pass only if every requirement in the`,
    "spec is met. For each requirement that is not met, give one entry naming what a user",
    "cannot do, where it happens, and the evidence file or mirror node URL that shows it.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The Playwright CLI ships its own agent skill; loading it beats explaining the CLI. */
function playwrightSkills(): string {
  return join(HARNESS_ROOT, "node_modules", "playwright-core", "lib", "tools");
}
