import { join } from "node:path";
import { type AttemptFailure, describeFailure } from "../failure.js";
import { cited } from "../evaluate.js";

/** What an attempt is told, so the next one can fix it. */
export interface Feedback {
  ok: boolean;
  failures: AttemptFailure[];
  /** Command output, carried to the repair prompt but not to `feedback.json`. */
  detail?: string;
}

/**
 * What the agent is told went wrong.
 *
 * A stage failure carries the command's own output, so it explains itself. A
 * verdict failure is one sentence from someone who watched the app in a browser
 * — so it gets the evidence too, by a path the agent can actually open. The
 * evaluator saves screenshots, page snapshots and saved responses, all of them
 * readable, and citing them by bare filename made them unfindable.
 */
export function repairPrompt(feedback: Feedback, artifacts: string): string {
  return [
    "That attempt did not pass. What went wrong:",
    "",
    ...feedback.failures.flatMap((failure) => [
      `- ${describeFailure(failure)}`,
      ...pointers(failure, artifacts),
    ]),
    feedback.detail === undefined ? "" : `\n${feedback.detail}`,
    "",
    "Fix it, then stop. Do not start the dev server or run the checks yourself —",
    "they run automatically once you are done.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Where to look. A stage failure points at its own output, a judged one at the
 * evidence behind it.
 */
function pointers(failure: AttemptFailure, artifacts: string): string[] {
  if (failure.kind === "verdict") {
    return failure.evidence.map((item) => `  ${located(item, artifacts)}`);
  }
  return [`  full output: ${join(artifacts, `${failure.stage}.txt`)}`];
}

/**
 * Evidence is a file the evaluator saved, or a URL it read. Only the first
 * needs a path, built with the same function that validated the citation, so
 * the two cannot disagree about its spelling.
 */
function located(evidence: string, artifacts: string): string {
  const name = cited(evidence);
  return name === evidence && /^https?:\/\//.test(evidence)
    ? evidence
    : join(artifacts, "evidence", name);
}

/**
 * What a continuation is told when no attempt reported a failure.
 *
 * `--continue` leaves the previous run's commits in the tree, and that was the
 * whole message: the prompt was the spec and nothing else, which reads as a
 * fresh build. A fresh build of a spec that is already half implemented is a
 * rewrite — one run spent an hour rebuilding 2,475 lines that were a `git log`
 * away, under different names, and ran out of wall clock before any of it was
 * tested.
 *
 * Reached two ways: a run that died before anything was judged, and a run that
 * passed — which is how a second spec builds on the first.
 */
export function carryOnPrompt(spec: string, attempt: number): string {
  const before =
    attempt === 0
      ? "a run that stopped before any attempt was judged"
      : `a run whose attempt ${attempt} passed`;
  return [
    `This branch already holds work towards the spec below, from ${before}.`,
    "",
    "Read what is there before writing anything: `git log` for what it committed, and the files those commits name. Then carry that work on — extend it, fix what is wrong with it, finish what is missing. Do not start again from scratch, and do not add a second version of something that is already there under another name. The code on this branch is the work so far, not a draft to replace.",
    "",
    "The spec, in full, because whatever is unbuilt still has to be built:",
    "",
    spec,
  ].join("\n");
}
