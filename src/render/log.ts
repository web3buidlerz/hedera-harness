import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "../commands.js";
import { type HarnessEvent, subscribe } from "../events.js";

/**
 * `harness.log` — one timestamped line per stage transition, plain text.
 *
 * A third renderer off the same stream, which is the cheapest evidence that
 * the seam is real. It deliberately ignores the high-frequency events: the
 * per-tool feed and the command heartbeats belong to a person watching, and
 * the JSONL transcripts already hold every agent message in full.
 *
 * Written synchronously. The volume is tens of lines per run, and it removes
 * any chance of losing the last few to a process that exits before an async
 * append has flushed — which is exactly the moment the log matters most.
 */
export function renderToLog(dir: string): () => void {
  const path = join(dir, "harness.log");
  // `baseline` during DOCTOR, `attempt-N` thereafter — the artifact directory
  // each command's output was written to, so a line points at its own file.
  let prefix = "baseline";

  // One event is one line, always. An event whose text happens to contain a
  // newline would otherwise split into two entries, the second of them
  // untimestamped and unattributable.
  const write = (message: string): void => {
    appendFileSync(path, `${new Date().toISOString()} ${message.replace(/\s*\n\s*/g, " ")}\n`);
  };

  return subscribe((event: HarnessEvent) => {
    switch (event.type) {
      case "run:started":
        write(`run ${event.stamp}`);
        write(`repo ${event.repo}`);
        if (event.spec !== undefined) write(`spec ${event.spec}`);
        write(`from ${event.from} at ${event.head}`);
        write(`max-attempts ${event.maxAttempts}, model ${event.model}`);
        return;

      case "phase:started":
        prefix = event.attempt === undefined ? "baseline" : `attempt-${event.attempt}`;
        if (event.phase === "generate") write(`generate attempt ${event.attempt}`);
        return;

      case "check":
        write(`check ${event.name}${event.remedy === undefined ? "" : `. ${event.remedy}`}`);
        return;

      case "command:started":
        write(`${prefix} ${event.name}: ${describe(event.command)}`);
        return;

      case "command:skipped":
        write(`${prefix} ${event.name} skipped (${event.reason})`);
        return;

      case "generate:finished":
        write(
          `generate attempt ${event.attempt} done — ${event.turns} turns, ` +
            `${event.toolCalls} tool calls`,
        );
        return;

      case "evaluate:finished":
        write(`evaluate attempt ${event.attempt} ${event.verdict}`);
        return;

      case "committed":
        write(
          event.sha === null
            ? `attempt ${event.attempt} changed nothing`
            : `attempt ${event.attempt} committed ${event.sha.slice(0, 12)}`,
        );
        return;

      case "attempt:finished":
        if (event.passed) {
          write(`attempt ${event.attempt} PASSED`);
          return;
        }
        write(
          `attempt ${event.attempt} FAILED — ${event.open} open, ` +
            `${event.fixed} fixed, ${event.fresh} new`,
        );
        for (const line of event.results) write(`  ${line}`);
        return;

      case "proposal":
        for (const { name, command } of event.commands) {
          write(`proposed ${name}: ${command === null ? "(none)" : describe(command)}`);
        }
        return;

      case "branch":
        write(`branch ${event.branch}`);
        return;

      case "note":
        write(event.text);
        return;

      case "spec:written":
        write(`wrote ${event.path}${event.tailored ? "" : " (generic skeleton)"}`);
        return;

      case "run:finished":
        write(
          event.cancelled
            ? "cancelled"
            : `${event.passed ? "passed" : "failed"} after ${event.attempts} attempt(s)`,
        );
        return;
    }
  });
}
