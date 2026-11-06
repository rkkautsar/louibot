#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBenchmarkCase } from "../../dist/benchmark.js";

const root = process.cwd();
const suiteDir = resolve(
  root,
  ".louibot/benchmarks/swe-multilingual-frontend-20261021",
);
const suite = JSON.parse(await readFile(join(suiteDir, "suite.json"), "utf8"));
const reportDir = join(suiteDir, "louibot");
await mkdir(reportDir, { recursive: true });
delete process.env.BENCHMARK_TOKEN_BUDGET;

const agent = resolve(root, "dist/benchmark-agent.js");
const configs = join(suiteDir, "configs");
const command = `node '${agent}' --config "${configs}/facebook__$BENCHMARK_CASE_ID.json"`;
const summaryPath = join(
  reportDir,
  process.env.LOUIBOT_BENCHMARK_RUN_ID
    ? `summary-${process.env.LOUIBOT_BENCHMARK_RUN_ID}.json`
    : "summary.json",
);
let previous = {};
try {
  previous = JSON.parse(await readFile(summaryPath, "utf8"));
} catch {}
const reports = previous.reports ?? [];
const completed = new Set(
  reports
    .filter(
      (item) =>
        item.status !== "agent-failed" && item.status !== "harness-error",
    )
    .map((item) => item.taskId ?? item.caseId),
);
const started = previous.started ?? new Date().toISOString();
const selectedCases = process.env.LOUIBOT_BENCHMARK_ONLY
  ? (
      await Promise.all(
        suite.cases.map(async (file) => ({
          file,
          taskId: JSON.parse(await readFile(resolve(file), "utf8")).taskId,
        })),
      )
    )
      .filter((item) => item.taskId === process.env.LOUIBOT_BENCHMARK_ONLY)
      .map((item) => item.file)
  : suite.cases;
const pending = await Promise.all(
  selectedCases.map(async (file) =>
    JSON.parse(await readFile(resolve(file), "utf8")),
  ),
);
if (pending.some((item) => !completed.has(item.taskId))) {
  execFileSync(
    "node",
    [
      join(
        root,
        "benchmarks/swe-multilingual/evaluate_docusaurus_shared_case.mjs",
      ),
      "--init-cache",
    ],
    { cwd: root, stdio: "inherit", timeout: 60_000 },
  );
  process.env.BENCHMARK_CACHE_WARMED = "1";
}
for (const file of selectedCases) {
  const caseValue = JSON.parse(await readFile(resolve(file), "utf8"));
  if (completed.has(caseValue.taskId)) continue;
  const token = JSON.parse(
    execFileSync("wrangler", ["auth", "token", "--json"], {
      cwd: suiteDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }),
  ).token;
  if (!token || /\s/.test(token))
    throw new Error("Wrangler did not return a usable credential");
  process.env.LOUIBOT_BENCHMARK_CF_TOKEN = token;
  console.log(
    JSON.stringify({ event: "case.start", caseId: caseValue.taskId }),
  );
  let report;
  try {
    report = await runBenchmarkCase(resolve(file), command, 3_600_000);
  } catch (error) {
    report = {
      caseId: caseValue.taskId,
      status: "harness-error",
      error: String(error),
      tokenUsage: null,
      costUsd: null,
    };
  }
  const reportId = report.taskId ?? report.caseId;
  const previousIndex = reports.findIndex(
    (item) => (item.taskId ?? item.caseId) === reportId,
  );
  if (previousIndex >= 0) reports[previousIndex] = report;
  else reports.push(report);
  const result = {
    started,
    updated: new Date().toISOString(),
    dataset: suite.dataset,
    datasetRevision: suite.datasetRevision,
    model: reports[0]?.model ?? "unknown",
    mode: "stateless",
    evaluationKind: "shared-runtime-task-tests",
    requested: suite.cases.length,
    completed: reports.length,
    passed: reports.filter((item) => item.status === "passed").length,
    maxCostUsdPerCase: 1,
    reports,
  };
  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
  completed.add(report.taskId ?? report.caseId);
  console.log(
    JSON.stringify({
      event: "case.done",
      caseId: report.taskId ?? report.caseId,
      status: report.status,
      costUsd: report.costUsd,
      tokenUsage: report.tokenUsage,
      elapsedSeconds: report.elapsedSeconds,
      solveSeconds: report.solveSeconds,
      evaluationSeconds: report.evaluationSeconds,
      totalSeconds: report.totalSeconds,
    }),
  );
  if (report.status === "agent-failed" || report.status === "harness-error")
    break;
}
console.log(
  JSON.stringify({
    event: "suite.done",
    completed: reports.length,
    passed: reports.filter((item) => item.status === "passed").length,
    costUsd: reports.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
  }),
);
