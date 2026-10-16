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
    image: "node:22",
    commandTimeoutSeconds: 120,
    network: "bridge",
  });
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
