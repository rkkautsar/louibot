import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBenchmarkCase } from "../../dist/benchmark.js";

const suiteDir = resolve(
  ".louibot/benchmarks/swe-multilingual-frontend-20261021",
);
const sourceDir = resolve(
  suiteDir,
  "paired-capped-compact-8927-outputcap-20261024",
);
const outDir = resolve(suiteDir, "paired-review-trail-8927-2reviews-20261024");
await mkdir(outDir, { recursive: true });

const original = JSON.parse(
  await readFile(resolve(sourceDir, "case.json"), "utf8"),
);
original.id = "docusaurus-8927-paired-review-trail-2reviews-20261024";
const caseFile = resolve(outDir, "case.json");
await writeFile(caseFile, `${JSON.stringify(original, null, 2)}\n`);

const config = JSON.parse(
  await readFile(resolve(sourceDir, "config.json"), "utf8"),
);
config.reviewer.pairedWorkflow.maxImplementationReviews = 2;
const configFile = resolve(outDir, "config.json");
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

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
process.env.CLOUDFLARE_ACCOUNT_ID = "3d2c7278332e1314ee55afa8743dd6bc";
process.env.CLOUDFLARE_API_TOKEN = token;
process.env.BENCHMARK_CACHE_WARMED = "1";
process.env.BENCHMARK_CONFIG_PATH = configFile;
process.env.BENCHMARK_COST_BUDGET_USD = "1";
delete process.env.BENCHMARK_TOKEN_BUDGET;

console.log(JSON.stringify({ event: "case.start", caseId: original.id }));
const report = await runBenchmarkCase(
  caseFile,
  `node '${resolve("dist/benchmark-agent.js")}' --config '${configFile}'`,
  30 * 60 * 1000,
);
const summary = {
  caseId: report.caseId,
  status: report.status,
  solveSeconds: report.solveSeconds,
  evaluationSeconds: report.evaluationSeconds,
  totalSeconds: report.totalSeconds,
  tokenUsage: report.tokenUsage,
  costUsd: report.costUsd,
  toolCalls: report.behavior?.toolCalls,
  conclusion: report.behavior?.summary,
  validation: report.evaluator,
  runDir: report.runDirectory,
};
await writeFile(
  resolve(outDir, "result.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(summary));
