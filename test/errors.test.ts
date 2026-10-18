import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseError, formatDiagnostic } from "../src/errors.js";

test("diagnostics pair bounded output failures with a recovery step", () => {
  const diagnostic = diagnoseError(
    new Error("The model returned another malformed or truncated tool call"),
  );
  assert.equal(diagnostic.name, "Error");
  assert.match(diagnostic.nextStep, /--max-output-tokens/);
});

test("diagnostics inspect nested network causes", () => {
  const error = new Error("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo failed"), {
      code: "EAI_AGAIN",
    }),
  });
  const diagnostic = diagnoseError(error);
  assert.equal(diagnostic.code, "EAI_AGAIN");
  assert.match(diagnostic.nextStep, /network connectivity/);
});

test("diagnostics redact credentials and retain a bounded stack for logs", () => {
  const name = "LOUIBOT_DIAGNOSTIC_SECRET";
  const previousValue = process.env[name];
  process.env[name] = "never-print-this-value";
  try {
    const error = new Error(`Request failed with token=${process.env[name]}`);
    const diagnostic = diagnoseError(error);
    assert.doesNotMatch(diagnostic.message, /never-print-this-value/);
    assert.match(diagnostic.message, /\[REDACTED\]/);
    assert.ok((diagnostic.stack?.length ?? 0) <= 8_000);
  } finally {
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
  }
});

test("formatted CLI diagnostics include an explicit next step", () => {
  assert.match(
    formatDiagnostic(
      Object.assign(new Error("No space left"), { code: "ENOSPC" }),
    ),
    /Next step: Free disk space/,
  );
});

test("diagnostics explain common endpoint and Docker access failures", () => {
  assert.match(
    diagnoseError(new Error("Model endpoint returned 404")).nextStep,
    /API root and omit \/chat\/completions/,
  );
  assert.match(
    diagnoseError(
      new Error("permission denied while connecting to docker.sock"),
    ).nextStep,
    /Docker socket access/,
  );
});
