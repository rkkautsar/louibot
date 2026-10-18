import assert from "node:assert/strict";
import test from "node:test";
import { cleanError } from "../src/doctor.js";

test("doctor errors redact credential assignments and bearer tokens", () => {
  assert.equal(
    cleanError(
      "token=supersecret password: 'hunter2' api_key=key-value Bearer ghp_abcdefgh123456",
    ),
    "token=[REDACTED] password: [REDACTED] api_key=[REDACTED] Bearer [REDACTED]",
  );
});

test("doctor errors redact values of secret environment variables", () => {
  const name = "LOUIBOT_REDACTION_SECRET";
  const previousValue = process.env[name];
  process.env[name] = "never-print-this-value";
  try {
    assert.equal(
      cleanError(`API rejected credential never-print-this-value`),
      "API rejected credential [REDACTED]",
    );
  } finally {
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
  }
});
