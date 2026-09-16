import { type HarnessEvent, subscribe } from "../events.js";

/**
 * One JSON object per line, for anything reading a run rather than watching
 * it — CI, a dashboard, a script that wants the verdict without parsing prose.
 *
 * It is this short only because events carry data. If a stage ever puts a
 * formatted sentence in an event, this renderer quietly becomes a way to read
 * the terminal output with extra steps.
 */
export function renderToJson(): () => void {
  return subscribe((event: HarnessEvent) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  });
}
