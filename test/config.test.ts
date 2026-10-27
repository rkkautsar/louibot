import assert from "node:assert/strict";
import test from "node:test";
import { schema } from "../src/config.js";

const base = {
  repository: "owner/repo",
  model: "anthropic/claude-test",
  agent: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
};

test("GitHub phase labels have defaults", () => {
  const config = schema.parse(base);
  assert.deepEqual(config.github, {
    issueLabel: "louibot:active",
    blockedLabel: "louibot:blocked",
    doneLabel: "louibot:done",
    pollIntervalSeconds: 30,
  });
  assert.deepEqual(config.sandbox, {
    image: "auto",
    commandTimeoutSeconds: 120,
    network: "bridge",
  });
  assert.deepEqual(config.validation, { commands: [], required: false });
  assert.equal(config.agent.contextWindowTokens, 200000);
  assert.equal(config.agent.maxInputTokens, 160000);
  assert.equal(config.agent.maxOutputTokens, 32000);
  assert.equal(config.agent.clarificationEnabled, true);
  assert.equal(config.agent.modelMaxRetries, 2);
  assert.equal(config.agent.modelRequestTimeoutSeconds, 180);
});

test("parallel job limit defaults to one and is bounded", () => {
  assert.equal(schema.parse(base).agent.maxConcurrentJobs, 1);
  assert.equal(
    schema.parse({
      ...base,
      agent: { ...base.agent, maxConcurrentJobs: 3 },
    }).agent.maxConcurrentJobs,
    3,
  );
  assert.throws(() =>
    schema.parse({
      ...base,
      agent: { ...base.agent, maxConcurrentJobs: 9 },
    }),
  );
});

test("GitHub label names can be configured", () => {
  const config = schema.parse({
    ...base,
    github: {
      issueLabel: "team:work",
      blockedLabel: "team:waiting",
      doneLabel: "team:shipped",
      pollIntervalSeconds: 45,
    },
  });
  assert.deepEqual(config.github, {
    issueLabel: "team:work",
    blockedLabel: "team:waiting",
    doneLabel: "team:shipped",
    pollIntervalSeconds: 45,
  });
});

test("sandbox network mode can disable internet access", () => {
  assert.equal(
    schema.parse({
      ...base,
      sandbox: { network: "none" },
    }).sandbox.network,
    "none",
  );
  assert.throws(() =>
    schema.parse({
      ...base,
      sandbox: { network: "host" },
    }),
  );
});

test("reviewer is opt-in and can use a separately priced model on the same provider", () => {
  assert.deepEqual(schema.parse(base).reviewer, {
    enabled: false,
    pairedWorkflow: {
      enabled: false,
      maxInvestigationRounds: 8,
      maxImplementationReviews: 4,
      evidenceJudge: {
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        apiTokenEnv: "CLOUDFLARE_API_TOKEN",
        inputUsdPerMillion: 0.038,
        minSupportedProbability: 0.85,
      },
    },
    maxSteps: 24,
  });
  const parsed = schema.parse({
    ...base,
    reviewer: {
      enabled: true,
      model: "anthropic/claude-reviewer",
      maxSteps: 8,
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 9,
    },
  });
  assert.equal(parsed.reviewer.model, "anthropic/claude-reviewer");
  assert.equal(parsed.reviewer.maxSteps, 8);
  assert.equal(parsed.reviewer.pairedWorkflow.enabled, false);
  const paired = schema.parse({
    ...base,
    reviewer: {
      enabled: true,
      pairedWorkflow: {
        enabled: true,
        maxInvestigationRounds: 8,
        maxImplementationReviews: 4,
      },
    },
  });
  assert.equal(paired.reviewer.pairedWorkflow.enabled, true);
  assert.equal(paired.reviewer.pairedWorkflow.maxInvestigationRounds, 8);
  assert.equal(paired.reviewer.pairedWorkflow.maxImplementationReviews, 4);
  assert.equal(
    paired.reviewer.pairedWorkflow.evidenceJudge.minSupportedProbability,
    0.85,
  );
  assert.throws(() =>
    schema.parse({
      ...base,
      reviewer: {
        enabled: true,
        pairedWorkflow: {
          enabled: true,
          maxInvestigationRounds: 9,
        },
      },
    }),
  );
  assert.throws(() =>
    schema.parse({
      ...base,
      reviewer: {
        pairedWorkflow: { enabled: true },
      },
    }),
  );
  assert.throws(() =>
    schema.parse({
      ...base,
      reviewer: {
        enabled: true,
        model: "openai/gpt-6-luna",
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 9,
      },
    }),
  );
  assert.throws(() =>
    schema.parse({
      ...base,
      reviewer: {
        enabled: true,
        model: "anthropic/claude-reviewer",
      },
    }),
  );
});
