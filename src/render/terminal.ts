import { relative } from "node:path";
import { describe } from "../commands.js";
import { type HarnessEvent, type Timings, subscribe } from "../events.js";
import { bold, dim, frame, green, heading, red, row, tick, warn, yellow } from "../style.js";

/** Width to clip a tool's argument to, so one call is always one line. */
const ARGUMENT_WIDTH = 96;

/**
 * The renderer a person watches.
 *
 * All of the state is here rather than in the stages: the clock column is
 * elapsed-since-this-phase-started, which is a property of how the output is
 * laid out, not of what happened. A stage that had to track it in order to
 * report it would be formatting, which is the thing the event seam exists to
 * stop.
 */
export function renderToTerminal(): () => void {
  let phaseStartedAt = Date.now();
  let repoRoot = "";

  const elapsed = (): string => formatClock(Date.now() - phaseStartedAt);

  return subscribe((event: HarnessEvent) => {
    switch (event.type) {
      case "run:started": {
        repoRoot = event.repo;
        // Read once, at a glance, to confirm the run is pointed where you think
        // it is. Labels dim, values at full strength — the values are the part
        // being checked.
        console.log(`\n${bold(`harness ${event.command}`)}  ${dim(event.stamp)}`);
        console.log(`${dim("repo  ")} ${event.repo}`);
        if (event.spec !== undefined) {
          console.log(`${dim("spec  ")} ${event.specInRepo ?? event.spec}`);
        }
        console.log(`${dim("from  ")} ${event.from} ${dim(`at ${event.head}`)}`);
        console.log(
          `${dim("model ")} ${event.model} ${dim(`· up to ${event.maxAttempts} attempt(s)`)}`,
        );
        return;
      }

      case "phase:started": {
        phaseStartedAt = Date.now();
        const attempt = event.attempt === undefined ? "" : `attempt ${event.attempt}`;
        const detail = [attempt, event.detail].filter((part) => part).join(" · ");
        console.log(heading(event.phase, detail));
        return;
      }

      case "check": {
        console.log(event.ok ? tick(event.name) : warn(event.name));
        if (event.remedy !== undefined) console.log(`  ${dim(event.remedy)}`);
        return;
      }

      case "command:started":
        console.log(row(event.name, describe(event.command)));
        return;

      case "command:skipped":
        console.log(row(event.name, `skipped (${event.reason})`));
        return;

      case "command:tick":
        // The row above already named the command; repeating it on every
        // heartbeat just pushes the output that actually changes further right.
        console.log(`  ${dim(formatClock(event.elapsedMs))}  ${dim(event.line || "running…")}`);
        return;

      case "tool":
        // The tool name is the only part at full strength — it is what the eye
        // scans for when skimming back through several hundred of these.
        console.log(
          `  ${dim(elapsed())}  ${event.tool.padEnd(7)} ` +
            `${dim(clip(relativise(event.argument, repoRoot)))}`,
        );
        return;

      case "generate:finished": {
        const cost = event.costUsd === undefined ? "" : `, ~$${event.costUsd.toFixed(2)} of tokens`;
        console.log(
          `  ${dim(elapsed())}  ` +
            dim(`done — ${event.turns} turns, ${event.toolCalls} tool calls${cost}`),
        );
        return;
      }

      case "evaluate:finished":
        // The verdict is the one thing in a stage that should not be toned down.
        console.log(
          `  ${dim(elapsed())}  ${
            event.verdict === "none"
              ? yellow("no verdict")
              : event.verdict === "pass"
                ? green("verdict: pass")
                : red(`verdict: fail — ${event.findings} finding(s)`)
          }`,
        );
        return;

      case "committed":
        console.log(
          dim(
            event.sha === null
              ? `  attempt ${event.attempt} changed nothing`
              : `  attempt ${event.attempt} committed ${event.sha.slice(0, 12)}`,
          ),
        );
        return;

      case "attempt:finished": {
        if (event.passed) {
          console.log(`\nattempt ${event.attempt} ${green("PASSED")}`);
          return;
        }
        const tally = `${event.open} open, ${event.fixed} fixed, ${event.fresh} new`;
        console.log(`\nattempt ${event.attempt} ${red("FAILED")} ${dim(`— ${tally}`)}`);
        // Findings stay at full strength: they are the reason to be reading this.
        for (const line of event.results) console.log(`  ${line}`);
        return;
      }

      case "branch":
        console.log(dim(`\nworking on ${event.branch}`));
        return;

      case "note":
        // A warning arrives mid-feed, so it gets a blank line above it or it is
        // just another grey row in three hundred.
        console.log(event.level === "warn" ? `\n${yellow(event.text)}` : event.text);
        return;

      case "spec:written":
        console.log(
          `\n${bold(event.path)}` +
            `${event.tailored ? "" : dim("  (generic skeleton — the agent was unreachable)")}\n` +
            `${dim("fill it in, then:")}  harness run --spec ${event.path}`,
        );
        return;

      case "run:finished": {
        // The one block worth screenshotting: the verdict, where the time went,
        // and the two paths you need next — the branch holding the work and the
        // run that explains it.
        const verdict = event.cancelled
          ? yellow("CANCELLED")
          : `${event.passed ? green("PASSED") : red("FAILED")} ${dim(`after ${event.attempts} attempt(s)`)}`;
        const lines = [verdict];
        if (!event.cancelled) lines.push(dim(describeTimings(event.timings)));
        if (event.branch !== null) lines.push(`${dim("branch")} ${event.branch}`);
        lines.push(`${dim("run   ")} ${relativise(event.dir, repoRoot)}`);

        // Everything a renderer produces goes to stdout, cancellation included:
        // one stream holds the whole narrative, so `harness run > log.txt`
        // captures it all. Only a thrown error reaches stderr.
        console.log(`\n${frame(lines)}\n`);
        return;
      }
    }
  });
}

/** `generate 7:46 · test 0:52 · evaluate 3:28` */
function describeTimings(timings: Timings): string {
  return [
    `generate ${formatDuration(timings.generateMs)}`,
    `test ${formatDuration(timings.testMs)}`,
    `evaluate ${formatDuration(timings.evaluateMs)}`,
  ].join(" · ");
}

/** `  0:04` — a running clock, right-aligned so rows line up. */
function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`.padStart(5);
}

/**
 * `7:46` for anything over a minute, `0.3s` below it. A stage that really took
 * 278ms rounded to `0:00` in the summary, which reads as "did not run" rather
 * than "was instant".
 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Absolute paths are most of a line and none of the information — the agent
 * works in one repo, so the root is noise repeated on every row.
 */
function relativise(text: string, root: string): string {
  if (root === "") return text;
  return text.startsWith(root) ? relative(root, text) || text : text.split(`${root}/`).join("");
}

/** Single line, ellipsis rather than wrapping — the transcript has the full text. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= ARGUMENT_WIDTH ? flat : `${flat.slice(0, ARGUMENT_WIDTH - 1)}…`;
}
