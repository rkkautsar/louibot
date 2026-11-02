import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBenchmarkCase } from '../../dist/benchmark.js';

const suiteDir = resolve('.louibot/benchmarks/swe-multilingual-frontend-20261021');
const runDate = '20261024';
const tasks = [
  {
    task: '10130',
    previous: 'The prior paired run did not establish the report against the external docs site. Its attempted website build stopped before link checking because the checkout lacked the external docs fixture. The focused in-repo test run failed on valid non-strict links with anchors, but it did not exercise the exact external example. Reassess the original report and use available source/tests to make a non-test source change if warranted.',
  },
  {
    task: '10309',
    previous: 'The prior paired run did not establish the report in a user-facing reproduction. Its local fixture failed Docusaurus config validation because generated snapshots for the requested versions were missing, so the server never started. The focused version-selection tests failed, but the prior attempt did not validate the dropdown in a working versioned site. Reassess the original report and use available source/tests to make a non-test source change if warranted.',
  },
];

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
process.env.BENCHMARK_COST_BUDGET_USD = '1';
delete process.env.BENCHMARK_TOKEN_BUDGET;

for (const { task, previous } of tasks) {
  const outDir = resolve(suiteDir, `paired-capped-compact-${task}-${runDate}`);
  await mkdir(outDir, { recursive: true });
  const casePath = resolve(suiteDir, `cases/docusaurus-${task}-paired-evidence-20261023.json`);
  const original = JSON.parse(await readFile(casePath, 'utf8'));
  original.id = `docusaurus-${task}-paired-capped-compact-${runDate}`;
  original.prompt += `\n\nPrevious attempt evidence: ${previous}`;
  const caseFile = resolve(outDir, 'case.json');
  await writeFile(caseFile, `${JSON.stringify(original, null, 2)}\n`);

  const sourceConfigFile = resolve(
    suiteDir,
    `configs/facebook__docusaurus-${task}-paired-evidence-20261023.json`,
  );
  const config = JSON.parse(await readFile(sourceConfigFile, 'utf8'));
  config.sandbox.setupCommands[1] = config.sandbox.setupCommands[1].replace(
    '&& yarn install --frozen-lockfile',
    '&& yarn install --ignore-scripts --frozen-lockfile',
  );
  config.reviewer.pairedWorkflow.maxInvestigationRounds = 2;
  config.reviewer.pairedWorkflow.maxImplementationReviews = 1;
  const configFile = resolve(outDir, 'config.json');
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

  process.env.BENCHMARK_CONFIG_PATH = configFile;
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
}
