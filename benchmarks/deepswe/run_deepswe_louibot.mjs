#!/usr/bin/env node
// Louibot driver for the DeepSWE v1.1 4-task subset (2 known-pass, 2 known-fail for deepseek-v4-flash).
// Usage: COMMANDCODE_API_KEY=... node benchmarks/deepswe/run_deepswe_louibot.mjs
// Env: CONCURRENCY (default 2), CASE_TIMEOUT_SECONDS (default 5400), ONLY=<taskId>
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const subset = join(root, ".louibot", "benchmarks", "deepswe-subset-20261115", "tasks");
const out = join(root, ".louibot", "benchmarks", "deepswe-subset-20261115", "louibot-commandcode");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const TIMEOUT = Number(process.env.CASE_TIMEOUT_SECONDS ?? 5400);
const ONLY = process.env.ONLY?.trim();

const TASKS = [
  { id: "ofetch-per-origin-circuit-breaker", expected: "pass" },
  { id: "true-myth-iterable-collection-combinators", expected: "pass" },
  { id: "awilix-async-container-initialization", expected: "fail" },
  { id: "superjson-error-stack-serialization", expected: "fail" },
  { id: "claude-code-by-agents-recursive-delegation", expected: "pass" },
  { id: "dynamodb-toolbox-lazy-recursive-schemas", expected: "pass" },
  { id: "happy-dom-deterministic-intersectionobserver", expected: "fail" },
  { id: "koota-composite-trait-aspects", expected: "fail" },
];

if (!process.env.COMMANDCODE_API_KEY) {
  console.error("COMMANDCODE_API_KEY is required");
  process.exit(2);
}

await mkdir(out, { recursive: true });
const summaryPath = join(out, "summary.json");
let previous = {};
try {
  previous = JSON.parse(await readFile(summaryPath, "utf8"));
} catch {}
const reports = previous.reports ?? [];
const started = previous.started ?? new Date().toISOString();
const completed = new Set(
  reports
    .filter((r) => r.status !== "agent-failed" && r.status !== "harness-error")
    .map((r) => r.caseId),
);
const pending = TASKS.filter((t) => !completed.has(t.id) && (!ONLY || t.id === ONLY));

const exec = (args) =>
  new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      args,
      { cwd: root, maxBuffer: 128 * 1024 * 1024, timeout: (TIMEOUT + 600) * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          // The CLI prints the report JSON then exits nonzero for failed cases;
          // prefer that report, fall back to both streams for real harness errors.
          try {
            resolvePromise(JSON.parse(String(stdout).slice(String(stdout).indexOf("{"))));
            return;
          } catch {}
          resolvePromise({
            caseId: null,
            status: "harness-error",
            error: `${String(stderr ?? "")}\n${String(error.stdout ?? "")}\n${error.message ?? ""}`
              .trim()
              .slice(-4000),
          });
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout.slice(stdout.indexOf("{"))));
        } catch (parseError) {
          resolvePromise({
            caseId: null,
            status: "harness-error",
            error: `unparseable CLI output: ${String(stdout).slice(-1000)} ${parseError}`,
          });
        }
      },
    );
  });

const writeSummary = async () => {
  const payload = {
    started,
    updated: new Date().toISOString(),
    dataset: "DeepSWE v1.1",
    model: "openai-compatible/deepseek/deepseek-v4-flash",
    endpoint: "https://api.commandcode.ai/provider/v1",
    requested: TASKS.length,
    completed: reports.length,
    passed: reports.filter((r) => r.status === "passed").length,
    reports,
  };
  await writeFile(summaryPath, JSON.stringify(payload, null, 2) + "\n");
};

const runOne = async (task) => {
  const dir = join(subset, task.id);
  console.log(JSON.stringify({ event: "case.start", caseId: task.id, expected: task.expected }));
  const report = await exec([
    join(root, "dist/cli.js"),
    "benchmark",
    "run",
    join(dir, "case.json"),
    "--config",
    join(dir, "config.json"),
    "--timeout-seconds",
    String(TIMEOUT),
  ]);
  report.caseId = task.id;
  report.expectedOutcome = task.expected;
  report.model = "openai-compatible/deepseek/deepseek-v4-flash";
  const index = reports.findIndex((r) => r.caseId === task.id);
  if (index >= 0) reports[index] = report;
  else reports.push(report);
  await writeSummary();
  console.log(
    JSON.stringify({
      event: "case.done",
      caseId: task.id,
      expected: task.expected,
      status: report.status,
      model: report.model,
      solveSeconds: report.solveSeconds ?? null,
      evaluationSeconds: report.evaluationSeconds ?? null,
      costUsd: report.costUsd ?? null,
      tokenUsage: report.tokenUsage?.total ?? null,
      evaluator: report.evaluator?.[0]?.stdout?.slice(0, 400) ?? null,
      error: report.error?.slice?.(0, 400) ?? null,
    }),
  );
};

let cursor = 0;
const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
  while (cursor < pending.length) {
    const task = pending[cursor++];
    await runOne(task);
  }
});
await Promise.all(workers);

console.log(
  JSON.stringify({
    event: "suite.done",
    expectedPass: TASKS.filter((t) => t.expected === "pass").map((t) => t.id),
    expectedFail: TASKS.filter((t) => t.expected === "fail").map((t) => t.id),
    statuses: reports.map((r) => ({ caseId: r.caseId, status: r.status })),
    passed: reports.filter((r) => r.status === "passed").length,
    requested: TASKS.length,
  }),
);
