import assert from "node:assert/strict";
import test from "node:test";
import { bold, dim, frame, green, heading, tick, verdict } from "../style.js";

/**
 * Tests run against the compiled output, where stdout is a pipe — so every
 * helper here is in its colourless mode. That is the half worth pinning: the
 * promise is that piped output is the terminal's output minus the escapes, and
 * `frame` is the one place where getting that wrong shows up as a ragged box.
 */

const ESCAPE = /\x1b\[[0-9;]*m/;

test("no colour when stdout is not a terminal", () => {
  for (const styled of [bold("x"), dim("x"), green("x"), heading("doctor"), tick("x")]) {
    assert.doesNotMatch(styled, ESCAPE, `${JSON.stringify(styled)} carries escape codes`);
  }
});

test("frame pads to the longest line", () => {
  const lines = frame(["a", "long line"]).split("\n");
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1, `ragged box: ${[...widths].join(", ")}`);
  assert.equal(lines.length, 4);
});

test("frame measures visible width, not escape codes", () => {
  // The failure this guards: padding computed on the styled string, which is
  // ~9 characters longer than what the eye sees, collapsing the right border.
  const plain = frame(["PASSED", "generate 1.0s"]).split("\n");
  const styled = frame([`\x1b[32mPASSED\x1b[0m`, "generate 1.0s"]).split("\n");
  assert.deepEqual(
    styled.map((line) => line.replace(new RegExp(ESCAPE, "g"), "")),
    plain,
  );
});

/**
 * This wording lived in both renderers, identically, until it did not. It is
 * the sentence a run exists to produce, so it must read the same whether you
 * watched it arrive or came back to it later.
 */
test("the verdict reads the same wherever it is shown", () => {
  assert.equal(verdict("pass", 0), "verdict: pass");
  assert.equal(verdict("fail", 2), "verdict: fail — 2 finding(s)");
  assert.equal(verdict("none", 0), "no verdict");
});
