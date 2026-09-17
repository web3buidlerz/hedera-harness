import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessEvent, subscribe } from "../events.js";

/** Where the durable record of a run is written, inside the run's directory. */
export const EVENTS_FILE = "events.jsonl";

/**
 * One JSON object per line — the whole of a run, losslessly.
 *
 * This replaced a hand-written `harness.log` renderer that formatted each event
 * into a sentence. That was a hundred lines of switch mirroring the terminal
 * renderer's switch, and it dropped the high-frequency events, so the file was
 * both duplicated effort and an incomplete record. A run is easier to read
 * afterwards from a complete machine-readable stream than from a prose summary
 * somebody has to keep in step by hand — and rendering it back into prose is
 * exactly the job `harness report` exists to do.
 *
 * It is this short only because events carry data. If a stage ever puts a
 * formatted sentence in an event, this quietly becomes a way to read the
 * terminal output with extra steps.
 */
function render(write: (line: string) => void): () => void {
  return subscribe((event: HarnessEvent) => {
    write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  });
}

/** `--json`, for anything reading a run rather than watching it. */
export function renderToJson(): () => void {
  return render((line) => void process.stdout.write(line));
}

/**
 * `events.jsonl` in the run directory, always, whichever renderer is on stdout.
 *
 * Written synchronously. The volume is small and it removes any chance of
 * losing the last few events to a process that exits before an async append has
 * flushed — which is exactly the moment the record matters most.
 */
export function renderToFile(dir: string): () => void {
  const path = join(dir, EVENTS_FILE);
  return render((line) => appendFileSync(path, line));
}
