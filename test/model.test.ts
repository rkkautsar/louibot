import assert from "node:assert/strict";
import test from "node:test";
import { schema } from "../src/config.js";
import { createModel } from "../src/model.js";
import { invokeWithMalformedToolCallRecovery } from "../src/agent.js";
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

function responseEvent(type: string, payload: Record<string, unknown>) {
  return { type, ...payload };
}

function responsesSse(events: unknown[], onCancel?: () => void) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < events.length) {
          const event = events[index++] as { type: string };
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        } else if (!onCancel) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function successfulToolResponse(argumentsJson: string) {
  const item = {
    id: "fc_test",
    type: "function_call",
    call_id: "call_test",
    name: "shell",
    arguments: argumentsJson,
  };
  const response = {
    id: "resp_test",
    object: "response",
    created_at: 1,
    model: "vendor/model-name",
    status: "completed",
    output: [item],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  return responsesSse([
    responseEvent("response.created", { response }),
    responseEvent("response.output_item.added", {
      output_index: 0,
      item: { ...item, arguments: "" },
    }),
    responseEvent("response.function_call_arguments.delta", {
      output_index: 0,
      delta: argumentsJson,
    }),
    responseEvent("response.output_item.done", { output_index: 0, item }),
    responseEvent("response.completed", { response }),
  ]);
}

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
    "https://gateway.example/v1/chat/completions",
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
test("compatible transport routes tool calls to explicit Chat Completions endpoint", async () => {
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
    const response = await createModel(
      schema.parse({
        ...base,
        endpoint: { ...base.endpoint, apiFormat: "chat-completions" },
      }),
    )
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
test("gateway-prefixed Luna uses Chat Completions when explicitly configured", () => {
  const c = schema.parse({
    ...base,
    model: "openai-compatible/openai/gpt-6-luna",
    endpoint: {
      ...base.endpoint,
      apiFormat: "chat-completions",
      reasoningEffort: "none",
    },
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

test("compatible Responses API uses reasoning and the Responses token limit", () => {
  const c = schema.parse({
    ...base,
    model: "openai-compatible/openai/gpt-6-luna",
    endpoint: {
      ...base.endpoint,
      apiFormat: "responses",
      reasoningEffort: "low",
    },
  });
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "test-value";
  try {
    const params = createModel(c, undefined, 1234).invocationParams();
    assert.equal(params.model, "openai/gpt-6-luna");
    assert.equal(params.max_output_tokens, 1234);
    assert.deepEqual(params.reasoning, { effort: "low" });
    assert.equal(params.max_completion_tokens, undefined);
    const override = createModel(c, undefined, 1234, {
      reasoningEffort: "minimal",
    }).invocationParams();
    assert.deepEqual(override.reasoning, { effort: "minimal" });
  } finally {
    if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
    else process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});

test("compatible Responses API streams function calls from the Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "responses-test-value";
  let called = false;
  globalThis.fetch = async (input, init) => {
    called = true;
    assert.equal(String(input), "https://compatible.example/v1/responses");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer responses-test-value");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "vendor/model-name");
    assert.equal(body.max_output_tokens, 1234);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.stream, true);
    return successfulToolResponse('{"command":"ls"}');
  };
  try {
    const c = schema.parse({
      ...base,
      endpoint: { ...base.endpoint, reasoningEffort: "low" },
    });
    assert.equal(c.endpoint?.apiFormat, "responses");
    const shell = tool(async ({ command }: { command: string }) => command, {
      name: "shell",
      description: "test shell",
      schema: z.object({ command: z.string() }),
    });
    const response = await createModel(c, undefined, 1234)
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

test("Responses transport tolerates omitted empty annotations", async () => {
  const originalFetch = globalThis.fetch;
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "responses-test-value";
  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hello" }],
  };
  const response = {
    id: "resp_test",
    object: "response",
    created_at: 1,
    model: "vendor/model-name",
    status: "completed",
    output: [message],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  globalThis.fetch = async () =>
    responsesSse([
      responseEvent("response.created", { response }),
      responseEvent("response.output_item.added", {
        output_index: 0,
        item: { ...message, content: [] },
      }),
      responseEvent("response.output_text.delta", {
        output_index: 0,
        content_index: 0,
        delta: "hello",
      }),
      responseEvent("response.output_item.done", {
        output_index: 0,
        item: message,
      }),
      responseEvent("response.completed", { response }),
    ]);
  try {
    const c = schema.parse({
      ...base,
      endpoint: { ...base.endpoint, apiFormat: "responses" },
    });
    const result = await createModel(c).invoke("Say hello");
    const text =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    assert.match(text, /hello/);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
    else process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});

test("Responses API aborts runaway shell arguments and recovers once", async () => {
  const originalFetch = globalThis.fetch;
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "responses-test-value";
  let calls = 0;
  let canceled = false;
  globalThis.fetch = async () => {
    calls++;
    if (calls > 1) return successfulToolResponse('{"command":"pwd"}');

    const item = {
      id: "fc_bad",
      type: "function_call",
      call_id: "call_bad",
      name: "shell",
      arguments: "",
    };
    const response = {
      id: "resp_bad",
      object: "response",
      created_at: 1,
      model: "vendor/model-name",
      status: "in_progress",
      output: [],
    };
    const events = [
      responseEvent("response.created", { response }),
      responseEvent("response.output_item.added", {
        output_index: 0,
        item,
      }),
      responseEvent("response.function_call_arguments.delta", {
        output_index: 0,
        delta: '{"command":"pwd"}' + " ".repeat(3_000),
      }),
    ];
    return responsesSse(events, () => {
      canceled = true;
    });
  };
  try {
    const c = schema.parse({
      ...base,
      endpoint: { ...base.endpoint, apiFormat: "responses" },
    });
    const shell = tool(async ({ command }: { command: string }) => command, {
      name: "shell",
      description: "test shell",
      schema: z.object({ command: z.string().max(2_000) }),
    });
    const model = createModel(c).bindTools([shell]);
    const result = await invokeWithMalformedToolCallRecovery(
      async () => ({
        structuredResponse: undefined,
        messages: [await model.invoke("Inspect files")],
      }),
      (output) => {
        const message = output.messages[0] as {
          tool_calls?: Array<{ name: string; args: unknown }>;
        };
        if (!message.tool_calls?.length)
          throw Object.assign(new Error("malformed response"), {
            name: "LOUIBOT_MALFORMED_TOOL_CALL",
          });
        return message.tool_calls[0];
      },
    );
    assert.equal(result.name, "shell");
    assert.deepEqual(result.args, { command: "pwd" });
    assert.equal(calls, 2);
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
    else process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});

test("Responses API aborts a repeated short shell-argument cycle", async () => {
  const originalFetch = globalThis.fetch;
  const old = process.env.LOUIBOT_TEST_CREDENTIAL;
  process.env.LOUIBOT_TEST_CREDENTIAL = "responses-test-value";
  let canceled = false;
  globalThis.fetch = async () => {
    const item = {
      id: "fc_loop",
      type: "function_call",
      call_id: "call_loop",
      name: "shell",
      arguments: "",
    };
    return responsesSse(
      [
        responseEvent("response.created", {
          response: {
            id: "resp_loop",
            object: "response",
            created_at: 1,
            model: "vendor/model-name",
            status: "in_progress",
            output: [],
          },
        }),
        responseEvent("response.output_item.added", {
          output_index: 0,
          item,
        }),
        responseEvent("response.function_call_arguments.delta", {
          output_index: 0,
          delta: '"}'.repeat(450),
        }),
      ],
      () => {
        canceled = true;
      },
    );
  };
  try {
    const c = schema.parse({
      ...base,
      endpoint: { ...base.endpoint, apiFormat: "responses" },
    });
    const shell = tool(async ({ command }: { command: string }) => command, {
      name: "shell",
      description: "test shell",
      schema: z.object({ command: z.string().max(20_000) }),
    });
    await assert.rejects(
      createModel(c).bindTools([shell]).invoke("Inspect files"),
      { name: "LOUIBOT_MALFORMED_TOOL_CALL" },
    );
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
    else process.env.LOUIBOT_TEST_CREDENTIAL = old;
  }
});

test(
  "Responses stream aborts when the provider stops sending output",
  { timeout: 8_000 },
  async () => {
    const originalFetch = globalThis.fetch;
    const old = process.env.LOUIBOT_TEST_CREDENTIAL;
    process.env.LOUIBOT_TEST_CREDENTIAL = "responses-test-value";
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Keep the response body open without sending any events.
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    try {
      const c = schema.parse({
        ...base,
        agent: { ...base.agent, modelRequestTimeoutSeconds: 1 },
      });
      await assert.rejects(
        createModel(c, undefined, 16).invoke("Inspect files"),
        /produced no output|timed out|aborted/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (old === undefined) delete process.env.LOUIBOT_TEST_CREDENTIAL;
      else process.env.LOUIBOT_TEST_CREDENTIAL = old;
    }
  },
);
