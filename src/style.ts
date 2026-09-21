/**
 * Terminal styling, in the smallest form that does the job.
 *
 * A run is watched for tens of minutes, so the eye needs somewhere to land:
 * which checks passed, where a stage began, how it ended. Colour here carries
 * meaning — green passed, red failed, dim is context you skim past. If colour
 * ever makes a failure harder to spot it has gone too far.
 *
 * Deliberately plain ANSI: no dependency, no alternate screen, no repainting.
 * Piped output is byte-identical minus the escape codes, so `harness run | tee`
 * and the scrollback say the same thing.
 */
const COLOUR = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

function paint(code: number): (text: string) => string {
  return (text) => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);

/** A passed check. The tick carries the colour; the text stays readable without it. */
export function tick(text: string): string {
  return `${green("✓")} ${text}`;
}

/** A check that did not pass but is not fatal — a missing skill set, a skipped stage. */
export function warn(text: string): string {
  return `${yellow("!")} ${text}`;
}

/**
 * `  build   yarn next:build` — one command in a stage, with the heartbeat
 * rows it emits indented underneath, so a stage and its output read as one
 * block. The `baseline`/`attempt-N` prefix stays in `harness.log` and off the
 * terminal, where the heading above already says which is running.
 */
export function row(stage: string, detail: string): string {
  return `  ${stage.padEnd(7)} ${dim(detail)}`;
}

/** `GENERATE  attempt 1 · sonnet · 40 skills` — anchors a long scrollback. */
export function heading(label: string, detail = ""): string {
  return `\n${bold(label.toUpperCase())}${detail === "" ? "" : `  ${dim(detail)}`}`;
}

/**
 * The block at the end of a run — the one people screenshot. Widths are
 * measured on visible characters, so styled content still lines up.
 */
export function frame(lines: string[]): string {
  const width = Math.max(...lines.map(visibleWidth));
  const rule = "─".repeat(width + 2);
  // The border is furniture; only what is inside should compete for attention.
  const edge = dim("│");
  return [
    dim(`┌${rule}┐`),
    ...lines.map((line) => `${edge} ${line}${" ".repeat(width - visibleWidth(line))} ${edge}`),
    dim(`└${rule}┘`),
  ].join("\n");
}

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
