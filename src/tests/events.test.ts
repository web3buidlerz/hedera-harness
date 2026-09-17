import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { type HarnessEvent, type Timings, collect, emit, reset, subscribe } from "../events.js";
import { describeMessage } from "../messages.js";
import { EVENTS_FILE, renderToFile, renderToJson } from "../render/json.js";
import { renderToTerminal } from "../render/terminal.js";
import { Run } from "../run.js";
import { runStages } from "../test.js";

afterEach(() => reset());

const NO_TIMINGS: Timings = { generateMs: 0, testMs: 0, evaluateMs: 0 };

/** Swaps stdout for the duration of a call, and hands back what was written. */
async function captured(body: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  process.stdout.write = ((chunk: string) => {
    lines.push(String(chunk).replace(/\n$/, ""));
    return true;
  }) as typeof process.stdout.write;
  try {
    await body();
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
  return lines;
}

test("a listener stops hearing events once it detaches", () => {
  const { events, stop } = collect();
  emit({ type: "branch", branch: "harness/one" });
  stop();
  emit({ type: "branch", branch: "harness/two" });
  assert.deepEqual(events.map((event) => (event as { branch: string }).branch), ["harness/one"]);
});

test("renderers are independent — one does not consume the stream", () => {
  let a = 0;
  let b = 0;
  subscribe(() => (a += 1));
  subscribe(() => (b += 1));
  emit({ type: "note", level: "info", text: "x" });
  assert.equal(a, 1);
  assert.equal(b, 1);
});

/**
 * The seam's whole claim is that a stage reports what happened and the renderer
 * decides how it reads. These two consume one identical stream.
 */
const STREAM: HarnessEvent[] = [
  {
    type: "run:started",
    command: "run",
    stamp: "2026-09-16T00-00-00-000Z",
    repo: "/repo",
    spec: "/repo/specs/x.md",
    specInRepo: "specs/x.md",
    from: "main",
    head: "abcdef123456",
    model: "sonnet",
    maxAttempts: 3,
  },
  { type: "phase:started", phase: "doctor" },
  { type: "check", name: "tooling", ok: true },
  {
    type: "proposal",
    commands: [
      { name: "install", command: { run: "npm install" }, note: "No lockfile." },
      { name: "test", command: null },
    ],
  },
  { type: "check", name: "no project skills", ok: false, remedy: "install them" },
  { type: "command:started", name: "build", command: { run: "yarn build" } },
  { type: "command:tick", elapsedMs: 10_000, line: "compiling" },
  { type: "phase:started", phase: "generate", attempt: 1, detail: "sonnet · 40 skills" },
  { type: "tool", tool: "Read", argument: "/repo/packages/app/page.tsx" },
  { type: "generate:finished", attempt: 1, turns: 9, toolCalls: 4, costUsd: 0.48, durationMs: 1_000 },
  { type: "committed", attempt: 1, sha: "4f2a91bc0d33aa" },
  {
    type: "attempt:finished",
    attempt: 1,
    passed: false,
    open: 0,
    fixed: 1,
    fresh: 2,
    failures: [
      {
        kind: "verdict",
        id: "aaaaaaaaaaaa",
        where: "/status",
        what: "renders undefined while loading",
        evidence: ["a.png"],
      },
      {
        kind: "stage",
        id: "bbbbbbbbbbbb",
        stage: "build",
        command: { run: "yarn next:build" },
        code: 1,
        timedOut: false,
        error: "Error: Cannot find module N",
        artifact: "attempt-1/build.txt",
      },
    ],
  },
  { type: "run:finished", passed: false, cancelled: false, attempts: 1, branch: "harness/x", timings: NO_TIMINGS, dir: "/repo/.harness/runs/x" },
];

test("the terminal renderer formats data it was never handed as prose", async () => {
  const lines = await captured(() => {
    renderToTerminal();
    for (const event of STREAM) emit(event);
  });
  const output = lines.join("\n");

  // Presentation the events do not carry: a tick, a sentence, a relative path.
  assert.match(output, /✓ tooling/);
  assert.match(output, /! no project skills/);
  assert.match(output, /done — 9 turns, 4 tool calls, ~\$0\.48 of tokens/);
  assert.match(output, /attempt 1 committed 4f2a91bc0d33\b/);
  assert.match(output, /FAILED.*— 0 open, 1 fixed, 2 new/);
  // Fields, glued into a sentence here and only here.
  assert.match(output, /\/status: renders undefined while loading \[a\.png\]/);
  assert.match(output, /build: `yarn next:build` exited 1/);
  // The repo root is stripped from tool arguments, which only the renderer knows.
  assert.match(output, /Read\s+packages\/app\/page\.tsx/);
  assert.doesNotMatch(output, /Read\s+\/repo\//);
});

test("the run directory keeps a lossless record of the stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-events-"));
  renderToFile(dir);
  for (const event of STREAM) emit(event);

  const written = await readFile(join(dir, EVENTS_FILE), "utf8");
  const recorded = written.trimEnd().split("\n").map((line) => JSON.parse(line) as HarnessEvent);

  // Lossless is the point: the old harness.log dropped the tool feed and the
  // command heartbeats, so a finished run could not be replayed from it.
  assert.deepEqual(
    recorded.map((event) => event.type),
    STREAM.map((event) => event.type),
  );
  assert.deepEqual(
    recorded.map(({ at: _at, ...event }: HarnessEvent & { at?: string }) => event),
    STREAM,
    "events must round-trip through the file unchanged",
  );
});

test("--json emits one parseable object per event, carrying the raw fields", async () => {
  const lines = await captured(() => {
    renderToJson();
    for (const event of STREAM) emit(event);
  });
  assert.equal(lines.length, STREAM.length);

  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    parsed.map((event) => event["type"]),
    STREAM.map((event) => event.type),
  );
  // Numbers stay numbers — the point of the seam. A consumer reads 0.48, not "~$0.48".
  const generated = parsed.find((event) => event["type"] === "generate:finished");
  assert.equal(generated?.["costUsd"], 0.48);
  assert.equal(generated?.["toolCalls"], 4);
});

/**
 * The guard for the class of bug, rather than another instance of it.
 *
 * Two leaks shipped before this existed: the interrupt notice and DOCTOR's
 * command proposal both wrote English straight to stdout, which put nine bare
 * lines of prose into the middle of a `--json` stream. Both were invisible to
 * every test that only checked what the renderers do with events they are
 * given, because the problem was output that never became an event at all.
 */
test("nothing outside a renderer writes to stdout", async () => {
  const src = fileURLToPath(new URL("../..", import.meta.url));
  const files = await readdir(join(src, "src"), { recursive: true, withFileTypes: true });

  const offenders: string[] = [];
  for (const file of files) {
    if (!file.name.endsWith(".ts")) continue;
    const path = join(file.parentPath, file.name);
    const relativePath = relative(join(src, "src"), path);
    // Renderers are the only place formatting belongs. Tests capture stdout to
    // assert on it. `cli.ts` keeps one console.error for a thrown error, which
    // is the one message that exists precisely because the run did not.
    if (relativePath.startsWith("render/") || relativePath.startsWith("tests/")) continue;

    const source = await readFile(path, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (!/\bconsole\.|process\.stdout\.write/.test(line)) continue;
      if (relativePath === "cli.ts" && line.includes("console.error")) continue;
      offenders.push(`${relativePath}:${index + 1}  ${line.trim()}`);
    }
  }

  assert.deepEqual(offenders, [], `output bypassing the event seam:\n${offenders.join("\n")}`);
});

test("describeMessage reports the raw subject, leaving the repo root to the renderer", () => {
  const message = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "ignored" },
        { type: "tool_use", name: "mcp__harness__submit_verdict", input: { file_path: "/repo/a.ts" } },
      ],
    },
  };
  assert.deepEqual(describeMessage(message), { tool: "submit_verdict", argument: "/repo/a.ts" });
  assert.equal(describeMessage({ type: "result" }), null);
});

/**
 * The loop's command half, asserted on events rather than by standing up an
 * agent to make it print something — which is the reason the seam exists.
 */
test("runStages stops at the first failing command and says so in events", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-stages-"));
  const run = await Run.create(repo, "stamp");
  const { events } = collect();

  const failure = await runStages({
    config: {
      install: { run: "true" },
      build: { run: "exit 3" },
      test: { run: "true" },
      serve: { run: "true" },
    },
    repoRoot: repo,
    run,
    prefix: "attempt-1",
  });

  assert.equal(failure?.stage, "build");
  assert.equal(failure?.code, 3);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("command:")).map((event) => [
      event.type,
      (event as { name?: string }).name,
    ]),
    [
      ["command:started", "install"],
      ["command:started", "build"],
    ],
    "`test` must not run after `build` failed",
  );
});
