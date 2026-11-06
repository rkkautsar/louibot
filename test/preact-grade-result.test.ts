import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPreactGrade } from "../benchmarks/swe-multilingual/preact-grade-result.mjs";

const grade = (overrides = {}) =>
  classifyPreactGrade({
    output: "✔ fixed\n✔ existing\nFinished in 1 secs / 1 secs",
    status: 0,
    error: null,
    signal: null,
    expectedFail: ["fixed"],
    expectedPass: ["existing"],
    ...overrides,
  });
test("passes only when both sets of required tests pass", () => {
  assert.equal(grade().passed, true);
  assert.equal(grade({ output: "✔ fixed\nFinished in 1 secs" }).passed, null);
});
test("classifies a completed assertion failure as a failed patch", () => {
  assert.equal(
    grade({ status: 1, output: "✖ fixed\n✔ existing\nFinished in 1 secs" })
      .passed,
    false,
  );
});
test("does not treat browser startup or container failure as a failed patch", () => {
  assert.equal(
    grade({
      output:
        "Chrome failed 2 times (cannot start). Giving up.\nFinished in 0 secs",
    }).passed,
    null,
  );
  assert.equal(
    grade({ status: null, error: new Error("spawn failed") }).passed,
    null,
  );
  assert.equal(grade({ signal: "SIGTERM", status: null }).passed, null);
  assert.equal(grade({ status: 1, output: "image not found" }).passed, null);
});
