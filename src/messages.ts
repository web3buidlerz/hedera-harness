/**
 * Reading the SDK's message stream.
 *
 * Parsing only — what a tool call *was*. How it looks on a terminal belongs to
 * a renderer, and lives in `render/terminal.ts`.
 */

/**
 * Pulls the one line worth reporting out of an SDK message, or null when there
 * is nothing to say. Tool inputs vary by tool, so this reads whichever field
 * carries the subject and falls back to the tool name alone.
 */
export function describeMessage(message: unknown): { tool: string; argument: string } | null {
  const candidate = message as { type?: string; message?: { content?: unknown } };
  if (candidate.type !== "assistant" || !Array.isArray(candidate.message?.content)) return null;

  for (const block of candidate.message.content as Array<Record<string, unknown>>) {
    if (block["type"] !== "tool_use") continue;
    const name = typeof block["name"] === "string" ? block["name"] : "tool";
    return { tool: shortName(name), argument: subjectOf(block["input"]) };
  }
  return null;
}

/** `mcp__harness__submit_verdict` reads as `verdict` in a live feed. */
function shortName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

function subjectOf(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}
