import assert from "node:assert/strict";
import test from "node:test";
import { knownPricing, reviewerRates } from "../src/pricing.js";

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

test("saved reviewer rates are retained for their configured model", () => {
  assert.equal(
    reviewerRates({
      model: "openai/gpt-6-luna",
      implementationModel: "openai/gpt-6-astra",
      savedModel: "openai/gpt-6-astra",
      savedReviewerModel: "openai/gpt-6-luna",
      hasSavedRates: true,
      implementationRates: {
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 50,
      },
    }),
    undefined,
  );
});

test("changing a reviewer model discards stale rates and selects current ones", () => {
  assert.deepEqual(
    reviewerRates({
      model: "openai/gpt-6-luna",
      implementationModel: "openai/gpt-6-astra",
      savedModel: "openai/gpt-6-astra",
      savedReviewerModel: "openai/gpt-6-sol",
      hasSavedRates: true,
      implementationRates: {
        inputUsdPerMillion: 10,
        outputUsdPerMillion: 50,
      },
    }),
    { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
  );
});
