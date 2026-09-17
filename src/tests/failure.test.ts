import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure, fromStage, fromVerdict } from "../failure.js";
import type { StageFailure } from "../test.js";

function stage(output: string, over: Partial<StageFailure> = {}): StageFailure {
  return {
    stage: "build",
    command: { run: "yarn next:build" },
    code: 1,
    timedOut: false,
    artifact: "attempt-1/build.txt",
    output,
    ...over,
  };
}

/**
 * The convergence mechanism in one assertion. The evaluator is fresh every
 * attempt and has never seen the app before, so it words the same bug
 * differently each time. Hashing what it said would make one recurring failure
 * look like a new one every attempt — the counts would read "1 fixed, 1 new"
 * forever, and the fresh-session reset would never fire.
 */
test("one bug described two ways is still one bug", () => {
  const first = fromVerdict({
    pass: false,
    failures: [
      { where: "/status", what: "the timestamp shows undefined while loading", evidence: ["a.png"] },
    ],
  });
  const second = fromVerdict({
    pass: false,
    failures: [
      { where: "/status", what: "a placeholder appears before data arrives", evidence: ["b.png"] },
    ],
  });
  assert.equal(first[0]?.id, second[0]?.id);
});

test("two bugs in different places are two bugs", () => {
  const [a, b] = fromVerdict({
    pass: false,
    failures: [
      { where: "/status", what: "same words", evidence: ["a.png"] },
      { where: "#status-error", what: "same words", evidence: ["a.png"] },
    ],
  });
  assert.notEqual(a?.id, b?.id);
});

test("a moving line number does not make a build failure look new", () => {
  const before = fromStage(stage("ok\nError: Cannot find module './x' at line 42\nmore"));
  const after = fromStage(stage("ok\nError: Cannot find module './x' at line 108\nmore"));
  assert.equal(before.id, after.id);
  assert.equal(before.kind === "stage" && before.error, "Error: Cannot find module './x' at line N");
});

test("a different error in the same stage is a different failure", () => {
  const a = fromStage(stage("Error: Cannot find module './x'"));
  const b = fromStage(stage("Error: Unexpected token"));
  assert.notEqual(a.id, b.id);
});

test("the fields carried are the ones a reader needs, not a sentence", () => {
  const failure = fromStage(stage("Error: boom", { timedOut: true, code: null }));
  assert.equal(failure.kind === "stage" && failure.artifact, "attempt-1/build.txt");
  // Gluing happens once, here, and only for a human.
  assert.equal(describeFailure(failure), "build: `yarn next:build` timed out");
  assert.equal(
    describeFailure({ kind: "verdict", id: "x", where: "/a", what: "broken", evidence: ["p.png"] }),
    "/a: broken [p.png]",
  );
});
