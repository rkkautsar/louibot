import assert from "node:assert/strict";
import test from "node:test";
import { knownPricing } from "../src/pricing.js";

test("known direct OpenAI models use the built-in published rates", () => {
  assert.deepEqual(knownPricing("openai/gpt-6-luna"), {
    inputUsdPerMillion: 0.1,
    outputUsdPerMillion: 0.5,
    source: "OpenAI published standard token pricing",
  });
});

test("compatible endpoints require explicit pricing", () => {
  assert.equal(knownPricing("openai-compatible/openai/gpt-6-luna"), undefined);
  assert.equal(knownPricing("anthropic/claude-sonnet"), undefined);
});
