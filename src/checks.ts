/**
 * Claims the harness can settle without asking anyone.
 *
 * A verdict must show its work. Today that confirms a cited screenshot exists;
 * this confirms the claim is true. The evaluator says what is worth checking —
 * it has used the app and knows what the run created — and the harness reads
 * the mirror node itself and decides. The agent never reports whether its own
 * check held.
 *
 * Chain reads first and alone, because they are the only kind that consults a
 * system the agent cannot influence. Re-reading a page the agent just read,
 * through the same browser, catches an agent misreporting and little else.
 *
 * Checks are data, never code. A test file could be edited by the generator on
 * the next attempt, could pass trivially, and would mean the harness running
 * the agent's own program to grade the agent — three ways of losing the thing
 * that makes this worth doing.
 */
import { emit } from "./events.js";

/** Attempts and spacing for a chain read, since state takes a moment to propagate. */
const ATTEMPTS = 3;
const SPACING_MS = 2_000;

/**
 * Deliberately small: enough to express a claim, too little to express a
 * program. No conditionals, and no check may refer to another — the moment one
 * expectation depends on another's result this is a language, and the reason a
 * person can read it in a second is gone.
 */
export type Expectation =
  | { equals: string | number }
  | { matches: string }
  | { contains: string }
  | { atLeast: number }
  /** Signed delta against the value when the check was declared. */
  | { changedBy: number }
  | { increasedBy: number };

export interface Check {
  /** `chain:accounts/0.0.2:balance.balance` — the same shape failure identity hashes. */
  id: string;
  kind: "chain";
  /** Mirror node path below `/api/v1/`, e.g. `accounts/0.0.2`. */
  path: string;
  /** Dotted path into the response, e.g. `balance.balance`. Values are in the units the mirror node reports. */
  field: string;
  expect: Expectation;
  /** The value when this was declared, for the delta expectations. */
  baseline?: number | undefined;
}

/**
 * A check resolves three ways, not two. `errored` means unexecutable — the
 * path 404s, the field is absent — and it is a warning, never a failure. A
 * mechanical layer that manufactures failures out of its own bugs stops being
 * the thing worth trusting over the judge.
 */
export interface CheckResult {
  check: Check;
  state: "held" | "failed" | "errored";
  /** What was found, or why it could not be read. Shown to a person as-is. */
  detail: string;
}

export function locate(path: string, field: string): string {
  return `chain:${path}:${field}`;
}

/** Reads `field` out of the mirror node's answer for `path`. */
export async function read(
  mirrorNode: string,
  path: string,
  field: string,
): Promise<{ value: unknown } | { error: string }> {
  const url = `${mirrorNode.replace(/\/$/, "")}/api/v1/${path.replace(/^\//, "")}`;
  const response = await fetch(url).catch((error: Error) => error);
  if (response instanceof Error) return { error: `${url} could not be reached: ${response.message}` };
  if (!response.ok) return { error: `${url} answered ${response.status}` };

  const body = (await response.json().catch(() => null)) as unknown;
  if (body === null) return { error: `${url} did not answer with JSON` };

  const value = field.split(".").reduce<unknown>(
    (into, key) => (into !== null && typeof into === "object" ? (into as Record<string, unknown>)[key] : undefined),
    body,
  );
  return value === undefined ? { error: `${url} has no ${field}` } : { value };
}

/**
 * Settles one check, retrying only while it fails. Chain state propagates, so a
 * claim made the instant after a transaction can be true and not yet visible;
 * an unreadable path is not retried, because that is not going to change.
 */
export async function settle(mirrorNode: string, check: Check): Promise<CheckResult> {
  let last: CheckResult | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const found = await read(mirrorNode, check.path, check.field);
    if ("error" in found) return { check, state: "errored", detail: found.error };

    last = compare(check, found.value);
    if (last.state === "held") return last;
    if (attempt < ATTEMPTS) await new Promise((resume) => setTimeout(resume, SPACING_MS));
  }
  return last ?? { check, state: "errored", detail: "no reading was taken" };
}

function compare(check: Check, value: unknown): CheckResult {
  const found = `found ${JSON.stringify(value)}`;
  const held = (state: boolean, expected: string): CheckResult => ({
    check,
    state: state ? "held" : "failed",
    detail: state ? found : `expected ${expected}, ${found}`,
  });
  const expect = check.expect;

  if ("matches" in expect) {
    return held(new RegExp(expect.matches).test(String(value)), `to match ${expect.matches}`);
  }
  if ("contains" in expect) {
    return held(String(value).includes(expect.contains), `to contain ${expect.contains}`);
  }
  if ("equals" in expect) {
    return held(String(value) === String(expect.equals), `${expect.equals}`);
  }

  // The numeric half. A field that is not a number is the check's mistake, not
  // the app's, so it errors rather than failing.
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return { check, state: "errored", detail: `${check.field} is not a number (${found})` };
  }
  if ("atLeast" in expect) return held(numeric >= expect.atLeast, `at least ${expect.atLeast}`);

  if (check.baseline === undefined) {
    return { check, state: "errored", detail: "no baseline was captured when this was declared" };
  }
  const moved = numeric - check.baseline;
  if ("increasedBy" in expect) {
    return held(moved === expect.increasedBy, `a rise of ${expect.increasedBy}, found ${moved}`);
  }
  return held(moved === expect.changedBy, `a change of ${expect.changedBy}, found ${moved}`);
}

/**
 * Captures the value a delta will be measured against, at the moment the check
 * is declared. This is why declaration precedes the action rather than the
 * verdict: "the balance rose by 2.5" is unverifiable if nothing was written
 * down beforehand, and by the time a verdict exists the moment has passed.
 */
export async function baseline(mirrorNode: string, check: Check): Promise<Check> {
  if (!("changedBy" in check.expect) && !("increasedBy" in check.expect)) return check;
  const found = await read(mirrorNode, check.path, check.field);
  if ("error" in found) return check;
  const numeric = Number(found.value);
  return Number.isNaN(numeric) ? check : { ...check, baseline: numeric };
}

/** Settles every check, reporting each as it lands. */
export async function settleAll(
  mirrorNode: string,
  checks: Check[],
  attempt: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await settle(mirrorNode, check);
    emit({
      type: "check:settled",
      id: result.check.id,
      state: result.state,
      detail: result.detail,
      attempt,
    });
    results.push(result);
  }
  return results;
}
