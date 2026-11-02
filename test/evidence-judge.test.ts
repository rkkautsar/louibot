import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { schema } from "../src/config.js";
import {
  judgeEvidenceClaims,
  judgePlanningReplies,
  judgePlanningReadiness,
  readWranglerOAuthToken,
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

test("Wrangler OAuth token can be read without exposing other credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "louibot-wrangler-token-"));
  const path = join(dir, "default.toml");
  try {
    writeFileSync(
      path,
      `oauth_token = "wrangler-test-token"\nexpiration_time = "2099-01-01T00:00:00Z"\nrefresh_token = "not-returned"\n`,
    );
    assert.equal(readWranglerOAuthToken(path), "wrangler-test-token");
    writeFileSync(
      path,
      `oauth_token = "expired-token"\nexpiration_time = "2000-01-01T00:00:00Z"\n`,
    );
    assert.equal(readWranglerOAuthToken(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Clef-Flash judges claims against captured shell commands and outputs", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  const requestBodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/account-test/ai/run/@cf/cloudflare/clef-flash",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer cloudflare-test-token");
    requestBodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        result: {
          model: "clef-flash",
          answers: {
            assessment: {
              choice: "supported",
              probabilities: {
                supported: 0.91,
                contradicted: 0.04,
                unverifiable: 0.05,
              },
              confidence: 0.91,
            },
          },
          usage: { input_tokens: 1_000 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await judgeEvidenceClaims({
      config: base,
      claims: [
        {
          kind: "example",
          text: "The build failed for the reported URL.",
          command: "docusaurus build",
        },
        { kind: "finding", text: "A matching control build passed." },
      ],
      shellEvidence: [
        {
          command: "docusaurus build",
          output: "Build failed: image not found.",
        },
      ],
      currentCostUsd: 0,
      maxCostUsd: 1,
    });
    assert.deepEqual(
      result.judgments.map(({ supported, verdict }) => ({
        supported,
        verdict,
      })),
      [
        { supported: true, verdict: "supported" },
        { supported: true, verdict: "supported" },
      ],
    );
    assert.equal(result.inputTokens, 2_000);
    assert.equal(result.estimatedCostUsd, 0.000076);
    assert.equal(requestBodies.length, 2);
    assert.deepEqual(Object.keys(requestBodies[0]!.questions as object), [
      "assessment",
    ]);
    assert.match(
      String(requestBodies[0]!.state),
      /Build failed: image not found/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
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

test("evidence judge refuses a request that would exceed the shared cost budget", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  globalThis.fetch = async () => {
    throw new Error("Should not call Cloudflare when over budget");
  };
  try {
    await assert.rejects(
      judgeEvidenceClaims({
        config: base,
        claims: [{ kind: "finding", text: "x".repeat(20_000) }],
        shellEvidence: [],
        currentCostUsd: 1,
        maxCostUsd: 1,
      }),
      /Cost budget exceeded/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
});

test("an example claim cannot pass without its claimed command in the shell trace", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: {
          answers: {
            assessment: {
              choice: "supported",
              probabilities: {
                supported: 0.99,
                contradicted: 0.005,
                unverifiable: 0.005,
              },
              confidence: 0.99,
            },
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  try {
    const result = await judgeEvidenceClaims({
      config: base,
      claims: [
        {
          kind: "example",
          command: "docusaurus build in a fresh control directory",
          text: "The control build succeeded.",
        },
      ],
      shellEvidence: [
        { command: "docusaurus build", output: "build failed: image missing" },
      ],
      currentCostUsd: 0,
      maxCostUsd: 1,
    });
    assert.equal(result.judgments[0]?.supported, false);
    assert.equal(result.judgments[0]?.verdict, "unverifiable");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
});

test("weak Clef support probability remains unverified", async () => {
  const originalFetch = globalThis.fetch;
  const oldAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-token";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: {
          answers: {
            assessment: {
              choice: "supported",
              probabilities: {
                supported: 0.5926,
                contradicted: 0.2,
                unverifiable: 0.2074,
              },
              confidence: 0.1812,
            },
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  try {
    const result = await judgeEvidenceClaims({
      config: base,
      claims: [
        { kind: "finding", command: "php-check", text: "The check passed." },
      ],
      shellEvidence: [{ command: "php-check", output: "passed" }],
      currentCostUsd: 0,
      maxCostUsd: 1,
    });
    assert.equal(result.judgments[0]?.supported, false);
    assert.equal(result.judgments[0]?.verdict, "unverifiable");
    assert.equal(result.judgments[0]?.confidence, 0.1812);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
});
