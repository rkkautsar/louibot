import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { schema } from "../src/config.js";
import {
  judgePlanningReplies,
  judgePlanningReadiness,
} from "../src/evidence-judge.js";

const base = schema.parse({
  repository: "owner/repo",
  model: "anthropic/claude-test",
  reviewer: {
    enabled: true,
    pairedWorkflow: { enabled: true },
  },
  agent: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  },
});

test("Clef-Flash checks whether planner replies address review threads", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        result: {
          answers: {
            assessment: {
              choice: "addressed",
              reason: "It references step-1.",
            },
          },
          usage: { input_tokens: 500 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await judgePlanningReplies({
      config: base,
      replies: [
        {
          concernId: "thread-1",
          disposition: "changed",
          reply: "Updated step-1 to include the path.",
          previousPlan: '{"proposedChanges":[]}',
          currentPlan: '{"proposedChanges":[{"id":"step-1"}]}',
        },
      ],
      currentCostUsd: 0,
      maxCostUsd: 1,
    });
    assert.equal(result.judgments[0]?.verdict, "addressed");
    assert.equal(result.judgments[0]?.concernId, "thread-1");
    assert.equal(result.inputTokens, 500);
    assert.equal(requestBody?.model, "clef-flash");
    assert.match(
      String(requestBody?.state),
      /narrow pre-review completeness check/,
    );
    assert.match(String(requestBody?.state), /Do not assess the concern/);
    assert.deepEqual(Object.keys(requestBody?.questions as object), [
      "assessment",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
});

test("Clef-Flash returns fixed choices for implementation-plan readiness", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        result: {
          answers: {
            steps: { choice: "concrete" },
            evidence: { choice: "linked" },
            validation: { choice: "reported_path" },
            uncertainty: { choice: "nonblocking" },
          },
          usage: { input_tokens: 600 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await judgePlanningReadiness({
      config: base,
      issue: { title: "Reported failure", body: "It fails on this path." },
      revisionId: "plan-2",
      plan: { proposedChanges: [{ id: "step-1" }] },
      repositoryNotes: "Relevant source and test paths.",
      currentCostUsd: 0,
      maxCostUsd: 1,
    });
    assert.equal(result.verdict, "ready");
    assert.deepEqual(result.choices, {
      steps: "concrete",
      evidence: "linked",
      validation: "reported_path",
      uncertainty: "nonblocking",
    });
    assert.equal(result.inputTokens, 600);
    assert.deepEqual(Object.keys(requestBody?.questions as object), [
      "steps",
      "evidence",
      "validation",
      "uncertainty",
    ]);
    assert.match(String(requestBody?.state), /plan-2/);
    assert.match(String(requestBody?.state), /broad investigation plan/);
    const questions = requestBody?.questions as Record<string, unknown>;
    for (const question of Object.values(questions))
      assert.equal((question as Record<string, unknown>).type, "choice");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
});

test("plan readiness rejects investigation plans and fails closed on missing choices", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  const responses = [
    {
      steps: { choice: "investigation_only" },
      evidence: { choice: "decisive_fact_missing" },
      validation: { choice: "narrower" },
      uncertainty: { choice: "bounded_blocker" },
    },
    { steps: { choice: "concrete" } },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ result: { answers: responses.shift() } }), {
      headers: { "content-type": "application/json" },
    });
  try {
    const args = {
      config: base,
      issue: { title: "Reported failure", body: "It fails on this path." },
      revisionId: "plan-1",
      plan: { proposedChanges: [] },
      repositoryNotes: "No causal path established yet.",
      currentCostUsd: 0,
      maxCostUsd: 1,
    };
    const investigation = await judgePlanningReadiness(args);
    assert.equal(investigation.verdict, "needs-investigation");
    const incomplete = await judgePlanningReadiness(args);
    assert.equal(incomplete.verdict, "revise");
    assert.equal(incomplete.choices.evidence, "unknown");
    assert.equal(incomplete.choices.validation, "unknown");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
});
