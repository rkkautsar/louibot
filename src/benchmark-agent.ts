/** Headless adapter for the real Louibot agent; no GitHub writes. */
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { code, type ApprovedPlanHandoff } from "./agent.js";
import { schema } from "./config.js";
import { Store, type Job } from "./store.js";

async function main() {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1])
    throw new Error(
      "Usage: node dist/benchmark-agent.js --config /absolute/config.yaml",
    );
  const configuration = schema.parse(
    parse(await readFile(process.argv[index + 1], "utf8")),
  );
  const promptFile = process.env.BENCHMARK_PROMPT_FILE;
  const resultFile = process.env.BENCHMARK_RESULT_FILE;
  if (!promptFile || !resultFile)
    throw new Error(
      "Run this adapter through louibot benchmark; prompt/result paths required",
    );
  const requestedCostBudget = Number(process.env.BENCHMARK_COST_BUDGET_USD);
  const costBudget =
    Number.isFinite(requestedCostBudget) && requestedCostBudget > 0
      ? Math.min(configuration.agent.maxCostUsd, requestedCostBudget)
      : configuration.agent.maxCostUsd;
  const seconds = Number(process.env.BENCHMARK_TIME_BUDGET_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Adapter requires a positive runtime limit");
  const stateDir = await mkdtemp(join(dirname(resultFile), "louibot-state-"));
  const store = new Store(stateDir);
  let input = 0,
    output = 0,
    tools = 0,
    calls = 0,
    usageCalls = 0;
  const roleUsage: Record<
    string,
    { input: number; output: number; cacheRead: number; calls: number }
  > = {};
  const log = store.log.bind(store);
  store.log = (issue, event, data) => {
    const modelEvent =
      /^(planner|synthesis|investigator|implementer|reviewer)\.model\.(start|end)$/.exec(
        event,
      );
    if (modelEvent?.[2] === "start") calls++;
    if (modelEvent?.[2] === "end") {
      const role = modelEvent[1]!;
      const envelope = data as {
        messages?: Array<{
          usage_metadata?: {
            input_tokens: number;
            output_tokens: number;
            input_token_details?: { cache_read?: number };
          };
          tool_calls?: unknown[];
        }>;
      };
      let found = false;
      const messages = envelope.messages ?? [
        data as NonNullable<typeof envelope.messages>[number],
      ];
      for (const message of messages) {
        tools += message.tool_calls?.length ?? 0;
        const usage = message.usage_metadata;
        if (
          usage &&
          Number.isFinite(usage.input_tokens) &&
          Number.isFinite(usage.output_tokens)
        ) {
          const cacheRead = Number(usage.input_token_details?.cache_read ?? 0);
          input += usage.input_tokens;
          output += usage.output_tokens;
          roleUsage[role] ??= { input: 0, output: 0, cacheRead: 0, calls: 0 };
          roleUsage[role].input += usage.input_tokens;
          roleUsage[role].output += usage.output_tokens;
          roleUsage[role].cacheRead += Number.isFinite(cacheRead)
            ? cacheRead
            : 0;
          roleUsage[role].calls += 1;
          found = true;
        }
      }
      if (found) usageCalls++;
    }
    log(issue, event, data);
  };
  const measuredConfig = {
    ...configuration,
    agent: { ...configuration.agent, maxCostUsd: costBudget },
  };
  let body = await readFile(promptFile, "utf8");
  if (process.env.BENCHMARK_CODE_MAP)
    body += `\n\nBase-tree code map:\n${await readFile(process.env.BENCHMARK_CODE_MAP, "utf8")}`;
  const job: Job = {
    issue: 1,
    title: process.env.BENCHMARK_CASE_ID ?? "benchmark",
    body,
    status: "coding",
    branch: "benchmark",
    worktree: process.cwd(),
    revision: 0,
    cost: 0,
    last: new Date().toISOString(),
    events: [],
    feedback: "",
    rounds: 0,
  };
  const handoffPath = process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE;
  let approvedPlan: ApprovedPlanHandoff | undefined;
  if (handoffPath) {
    approvedPlan = JSON.parse(await readFile(handoffPath, "utf8"));
    if (!approvedPlan?.approved || !approvedPlan.revisionId)
      throw new Error(
        "The implementation plan handoff is incomplete or unapproved",
      );
  }
  store.save(job);
  const controller = new AbortController();
  // Leave time for Docker cleanup before the harness kills the process group.
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, seconds * 1000 - 5000),
  );
  let result: Record<string, unknown>;
  try {
    const planningOnly = process.env.BENCHMARK_PLANNING_ONLY === "1";
    const response = await code(measuredConfig, job, store, controller.signal, {
      planningOnly,
      approvedPlan,
      refreshCredentials:
        process.env.BENCHMARK_REFRESH_WRANGLER_TOKEN === "1"
          ? () => {
              const apiKeyEnv = measuredConfig.endpoint?.apiKeyEnv;
              if (!apiKeyEnv)
                throw new Error(
                  "Wrangler credential refresh requires a configured API key environment variable",
                );
              const token = JSON.parse(
                execFileSync("wrangler", ["auth", "token", "--json"], {
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: 60_000,
                }),
              ).token;
              if (!token || /\s/.test(token))
                throw new Error("Wrangler did not return a usable credential");
              process.env[apiKeyEnv] = token;
              process.env.CLOUDFLARE_API_TOKEN = token;
              store.registerSecret(token);
            }
          : undefined,
    });
    result = {
      action: response.planningOnly
        ? "plan"
        : response.status === "done"
          ? "implement"
          : (response.status as string) === "clarify"
            ? "clarify"
            : response.status === "inconclusive"
              ? "inconclusive"
              : "decline",
      conclusion: response.status,
      questions: response.questions,
      summary: response.summary,
      planning: response.planning,
      planningEvidenceLedger: response.planningEvidenceLedger,
      planningNotes: response.planningNotes,
      planningRevisionId: response.planningRevisionId,
      planningThreads: response.planningThreads,
      planningReviewApproved: response.planningReviewApproved,
      planningReportedBehaviors: response.planningReportedBehaviors,
      investigationRounds: response.investigationRounds,
      planningClefBlocks: response.planningClefBlocks,
      implementationReviewApproved: response.implementationReviewApproved,
      implementationReviewRounds: response.implementationReviewRounds,
      implementationReviewThreads: response.implementationReviewThreads,
      status: "completed",
    };
  } catch (error) {
    const errorText = String(error);
    const credential = configuration.endpoint
      ? process.env[configuration.endpoint.apiKeyEnv]
      : undefined;
    result = {
      status: "failed",
      error: credential
        ? errorText.split(credential).join("[REDACTED]")
        : errorText,
      questions: [],
    };
    store.log(job.issue, "benchmark.error", result.error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
  const complete = calls > 0 && calls === usageCalls;
  await writeFile(
    resultFile,
    JSON.stringify(
      {
        ...result,
        model: configuration.model,
        configSha256: createHash("sha256")
          .update(JSON.stringify(configuration))
          .digest("hex"),
        inputTokens: complete ? input : null,
        outputTokens: complete ? output : null,
        cacheReadTokens: complete
          ? Object.values(roleUsage).reduce(
              (total, usage) => total + usage.cacheRead,
              0,
            )
          : null,
        roleUsage: complete ? roleUsage : null,
        toolCalls: tools,
        costUsd: complete
          ? Object.entries(roleUsage).reduce((total, [role, usage]) => {
              const rates =
                role === "reviewer"
                  ? {
                      input:
                        configuration.reviewer.inputUsdPerMillion ??
                        configuration.agent.inputUsdPerMillion,
                      output:
                        configuration.reviewer.outputUsdPerMillion ??
                        configuration.agent.outputUsdPerMillion,
                    }
                  : role === "planner" || role === "synthesis"
                    ? {
                        input:
                          configuration.reviewer.pairedWorkflow
                            .plannerInputUsdPerMillion ??
                          configuration.agent.inputUsdPerMillion,
                        output:
                          configuration.reviewer.pairedWorkflow
                            .plannerOutputUsdPerMillion ??
                          configuration.agent.outputUsdPerMillion,
                      }
                    : {
                        input: configuration.agent.inputUsdPerMillion,
                        output: configuration.agent.outputUsdPerMillion,
                      };
              return (
                total +
                (usage.input * rates.input + usage.output * rates.output) / 1e6
              );
            }, 0)
          : null,
        costBudgetUsd: costBudget,
        budgetEnforced: false,
        budgetPolicy:
          "Uses the configured per-token input and output prices with a hard monetary ceiling; the harness separately bounds runtime and agent steps.",
      },
      null,
      2,
    ),
  );
  store.db.close();
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
