import assert from "node:assert/strict";
import test from "node:test";
import { schema } from "../src/config.js";
import { createModel } from "../src/model.js";
import { tool } from "langchain";
import { z } from "zod";
const base = {
  repository: "owner/repo",
  model: "openai-compatible/vendor/model-name",
  endpoint: {
    baseUrl: "https://compatible.example/v1",
    apiKeyEnv: "LOUIBOT_TEST_CREDENTIAL",
  },
  agent: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
};

test("compatible configuration requires endpoint and keeps model names with slashes", () => {
  const c = schema.parse(base);
  assert.equal(c.model, "openai-compatible/vendor/model-name");
  assert.equal(
    schema.safeParse({ ...base, endpoint: undefined }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...base, model: "openai/test" }).success,
    false,
  );
  for (const baseUrl of [
    "file:///tmp/test",
    "https://user:pass@example.com",
    "https://example.com?key=secret",
  ])
    assert.equal(
      schema.safeParse({ ...base, endpoint: { ...base.endpoint, baseUrl } })
        .success,
      false,
    );
});
test("compatible model fails clearly when its host key is missing", () => {
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  delete process.env.LOUIBOT_TEST_CREDENTIAL;
  try {
    assert.throws(
      () => createModel(schema.parse(base)),
      /Set LOUIBOT_TEST_CREDENTIAL/,
    );
  } finally {
    if (old !== undefined) process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});
test("compatible transport routes tool calls to custom Chat Completions endpoint", async () => {
  const originalFetch = globalThis.fetch,
    old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "compatible-test-value";
  let called = false;
  globalThis.fetch = async (input, init) => {
    called = true;
    assert.equal(
      String(input),
      "https://compatible.example/v1/chat/completions",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer compatible-test-value");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "vendor/model-name");
    assert.equal(body.tools[0].function.name, "shell");
    return new Response(
      JSON.stringify({
        id: "test",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "shell", arguments: '{"command":"ls"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    const shell = tool(async ({ command }: { command: string }) => command, {
      name: "shell",
      description: "test shell",
      schema: z.object({ command: z.string() }),
    });
    const response = await createModel(schema.parse(base))
      .bindTools([shell])
      .invoke("Inspect files");
    assert.equal(called, true);
    assert.equal(response.tool_calls?.[0].name, "shell");
    assert.deepEqual(response.tool_calls?.[0].args, { command: "ls" });
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
    else process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});
test("gateway-prefixed Luna uses completion limit and explicit reasoning setting", () => {
  const c = schema.parse({
    ...base,
    model: "openai-compatible/openai/gpt-6-luna",
    endpoint: { ...base.endpoint, reasoningEffort: "none" },
  });
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "test-value";
  try {
    const params = createModel(c).invocationParams();
    assert.equal(params.model, "openai/gpt-6-luna");
    assert.equal(params.max_tokens, undefined);
    assert.equal(params.max_completion_tokens, c.agent.maxOutputTokens);
    assert.equal(params.reasoning_effort, "none");
  } finally {
    if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
    else process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});
