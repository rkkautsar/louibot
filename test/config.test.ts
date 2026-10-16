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
    issueLabel: "louibot:ready",
    blockedLabel: "louibot:blocked",
    doneLabel: "louibot:done",
    pollIntervalSeconds: 30,
  });
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
