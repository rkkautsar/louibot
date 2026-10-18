import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parseAgentResponse } from "../src/agent.js";

const resultSchema = z.object({ status: z.string() });

test("malformed or truncated model tool calls get an actionable output-limit error", () => {
  assert.throws(
    () =>
      parseAgentResponse(
        undefined,
        [
          {
            invalid_tool_calls: [{ name: "shell", error: "invalid JSON" }],
          },
        ],
        resultSchema,
        4096,
      ),
    /malformed or truncated tool call.*4096-token output limit.*--max-output-tokens/,
  );
  assert.throws(
    () =>
      parseAgentResponse(
        undefined,
        [{ response_metadata: { finish_reason: "length" } }],
        resultSchema,
        4096,
      ),
    /malformed or truncated tool call/,
  );
});

test("a structured model result is validated normally", () => {
  assert.deepEqual(
    parseAgentResponse({ status: "done" }, [], resultSchema, 4096),
    { status: "done" },
  );
});
