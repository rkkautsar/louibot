import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanError,
  modelCredentialSource,
  probeModelAccess,
} from "../src/doctor.js";
import { schema } from "../src/config.js";

const compatibleConfig = schema.parse({
  repository: "owner/repo",
  model: "openai-compatible/openai/gpt-6-luna",
  endpoint: {
    baseUrl: "https://gateway.example/ai/v1",
    apiKeyEnv: "LOUIBOT_DOCTOR_TOKEN",
  },
  agent: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
});

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

test("doctor names the selected host credential source without exposing it", () => {
  assert.equal(
    modelCredentialSource(compatibleConfig),
    "host environment variable LOUIBOT_DOCTOR_TOKEN (value hidden)",
  );
});

test("doctor probes using the configured credential and reports only its name", async () => {
  const name = "LOUIBOT_DOCTOR_TOKEN";
  const previousValue = process.env[name];
  process.env[name] = "never-print-this-value";
  let called = false;
  try {
    assert.equal(
      await probeModelAccess(compatibleConfig, async () => {
        called = true;
        return {};
      }),
      "request succeeded using LOUIBOT_DOCTOR_TOKEN (value hidden)",
    );
    assert.equal(called, true);
  } finally {
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
  }
});

test("doctor gives the connectivity probe enough output budget for Luna", async () => {
  const name = "LOUIBOT_DOCTOR_TOKEN";
  const previousValue = process.env[name];
  const originalFetch = globalThis.fetch;
  process.env[name] = "doctor-test-value";
  let requestedTokens: number | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requestedTokens = body.max_completion_tokens;
    return new Response(
      JSON.stringify({
        id: "doctor-probe",
        object: "chat.completion",
        created: 1,
        model: "openai/gpt-6-luna",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    await probeModelAccess(compatibleConfig);
    assert.equal(requestedTokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousValue === undefined) delete process.env[name];
    else process.env[name] = previousValue;
  }
});

test("doctor does not make an API request when the selected key is missing", async () => {
  const name = "LOUIBOT_DOCTOR_MISSING_TOKEN";
  const previousValue = process.env[name];
  delete process.env[name];
  let called = false;
  try {
    await assert.rejects(
      probeModelAccess(
        {
          ...compatibleConfig,
          endpoint: { ...compatibleConfig.endpoint, apiKeyEnv: name },
        },
        async () => {
          called = true;
        },
      ),
      new RegExp(`${name} is not set`),
    );
    assert.equal(called, false);
  } finally {
    if (previousValue !== undefined) process.env[name] = previousValue;
  }
});
