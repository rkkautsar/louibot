import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  invokeWithMalformedToolCallRecovery,
  parseAgentResponse,
} from "../src/agent.js";

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

test("malformed tool calls receive exactly one recovery attempt", async () => {
  let calls = 0;
  const result = await invokeWithMalformedToolCallRecovery(
    async (recovery) => {
      calls++;
      assert.equal(recovery, calls === 2);
      return recovery
        ? { structuredResponse: { status: "done" }, messages: [] }
        : {
            structuredResponse: undefined,
            messages: [{ invalid_tool_calls: [{ error: "invalid JSON" }] }],
          };
    },
    (out) =>
      parseAgentResponse(
        out.structuredResponse,
        out.messages,
        resultSchema,
        4096,
      ),
  );
  assert.deepEqual(result, { status: "done" });
  assert.equal(calls, 2);
});

test("repeated malformed tool calls stop after the bounded recovery attempt", async () => {
  let calls = 0;
  await assert.rejects(
    invokeWithMalformedToolCallRecovery(
      async () => {
        calls++;
        return {
          structuredResponse: undefined,
          messages: [{ invalid_tool_calls: [{ error: "invalid JSON" }] }],
        };
      },
      (out) =>
        parseAgentResponse(
          out.structuredResponse,
          out.messages,
          resultSchema,
          4096,
        ),
    ),
    /after Louibot's one recovery attempt/,
  );
  assert.equal(calls, 2);
});
