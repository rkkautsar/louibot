import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBenchmarkCase } from '../../dist/benchmark.js';

const suiteDir = resolve('.louibot/benchmarks/swe-multilingual-frontend-20261021');
const outDir = resolve(suiteDir, 'paired-capped-compact-8927-20261024');
await mkdir(outDir, { recursive: true });

const original = JSON.parse(
  await readFile(resolve(suiteDir, 'cases/docusaurus-8927-paired-20261023.json'), 'utf8'),
);
original.id = 'docusaurus-8927-paired-capped-compact-20261024';
original.prompt += `

Previous attempt evidence: an earlier Louibot run inspected the Markdown asset transformation code and tests, then stopped without a source change because it could not locate the reported behavior. It asked for clarification even though clarification was disabled. The report says relative image assets inside a directory whose name contains .md are incorrectly looked up under /static. Reassess the report in this checkout, test the reported path behavior, and make a non-test source change if warranted.`;
const caseFile = resolve(outDir, 'case.json');
await writeFile(caseFile, `${JSON.stringify(original, null, 2)}\n`);

const config = JSON.parse(
  await readFile(resolve(suiteDir, 'configs/facebook__docusaurus-8927-paired-20261023.json'), 'utf8'),
);
config.reviewer.pairedWorkflow.maxInvestigationRounds = 2;
config.reviewer.pairedWorkflow.maxImplementationReviews = 1;
const configFile = resolve(outDir, 'config.json');
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

const token = JSON.parse(
  execFileSync('wrangler', ['auth', 'token', '--json'], {
    cwd: suiteDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }),
).token;
if (!token || /\s/.test(token)) throw new Error('Wrangler did not return a usable credential');
process.env.LOUIBOT_BENCHMARK_CF_TOKEN = token;
process.env.CLOUDFLARE_ACCOUNT_ID = '3d2c7278332e1314ee55afa8743dd6bc';
process.env.CLOUDFLARE_API_TOKEN = token;
process.env.BENCHMARK_CACHE_WARMED = '1';
process.env.BENCHMARK_CONFIG_PATH = configFile;
process.env.BENCHMARK_COST_BUDGET_USD = '1';
delete process.env.BENCHMARK_TOKEN_BUDGET;

console.log(JSON.stringify({ event: 'case.start', caseId: original.id }));
const report = await runBenchmarkCase(
  caseFile,
  `node '${resolve('dist/benchmark-agent.js')}' --config '${configFile}'`,
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
await writeFile(resolve(outDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary));
