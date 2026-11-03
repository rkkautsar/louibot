import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  benchmarkStatusIsSuccessful,
  runBenchmarkCase,
  runBenchmarkSuite,
} from "../src/benchmark.js";

const roots: string[] = [],
  runDirs: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
  for (const path of runDirs.splice(0))
    await rm(path, { recursive: true, force: true });
});

test("an approved planning-only benchmark is a successful CLI result", () => {
  assert.equal(benchmarkStatusIsSuccessful("planning-approved"), true);
  assert.equal(benchmarkStatusIsSuccessful("planning-unapproved"), false);
  assert.equal(benchmarkStatusIsSuccessful("planning-failed"), false);
});

test("benchmark captures a patch, replays only scripted replies, and uses a shallow isolated base", async () => {
  const root = await mkdtemp(join(tmpdir(), "louibot-benchmark-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  await writeFile(join(repo, "value.js"), "export const value = 1;\n");
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const evaluator = join(root, "evaluator.mjs"),
    agent = join(root, "agent.mjs"),
    lifecycle = join(root, "lifecycle.txt"),
    hook = join(root, "hook.mjs");
  await writeFile(
    hook,
    `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(lifecycle)}, process.argv[2] + '\\n'); if (process.argv[2] === 'wait') console.log(JSON.stringify({ setupSeconds: 0.25 }));`,
  );
  await writeFile(
    evaluator,
    `import assert from 'node:assert/strict'; import { appendFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url'; import { join } from 'node:path'; appendFileSync(${JSON.stringify(lifecycle)}, 'evaluate\\n'); const value = await import(pathToFileURL(join(process.cwd(), 'value.js'))); assert.equal(value.value, 2);`,
  );
  await writeFile(
    agent,
    `import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs'; appendFileSync(${JSON.stringify(lifecycle)}, 'agent\\n'); const prompt = readFileSync(process.env.BENCHMARK_PROMPT_FILE, 'utf8'); if (readFileSync('.git/shallow', 'utf8').trim().length === 0 || existsSync('.git/objects/info/alternates')) process.exit(3); if (prompt.includes('Maintainer reply 1:')) { if (!prompt.includes('Louibot asked:')) process.exit(4); writeFileSync('value.js', 'export const value = 2;\\n'); } const action = prompt.includes('Maintainer reply 1:') ? 'implement' : 'clarify'; writeFileSync(process.env.BENCHMARK_RESULT_FILE, JSON.stringify({ action, inputTokens: 10, outputTokens: 5, costUsd: 0.01, budgetEnforced: false, questions: action === 'clarify' ? ['Should the value become two?'] : [], toolCalls: 1 }));`,
  );
  const caseFile = join(root, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "tiny-patch",
      repositoryPath: repo,
      baseCommit,
      prompt: "Set value to two.",
      expectedFirstAction: "clarify",
      scriptedReplies: ["Yes, set it to two."],
      evaluator: {
        prepareCommand: `node '${hook}' prepare`,
        waitCommand: `node '${hook}' wait`,
        cleanupCommand: `node '${hook}' cleanup`,
        commands: [`node '${evaluator}'`],
      },
    }),
  );
  const result = await runBenchmarkCase(caseFile, `node '${agent}'`, 10_000);
  runDirs.push(result.runDirectory);
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.tokenUsage.total, 30);
  assert.equal(result.tokenBudgetEnforced, false);
  assert.equal(result.behavior.firstAction, "clarify");
  assert.equal(result.behavior.action, "implement");
  assert.equal(result.behavior.firstActionMatches, true);
  assert.equal(typeof result.solveSeconds, "number");
  assert.equal(result.elapsedSeconds, result.solveSeconds);
  assert.equal(typeof result.totalSeconds, "number");
  assert.ok(
    result.totalSeconds >= result.elapsedSeconds + result.evaluationSeconds,
  );
  assert.equal(typeof result.evaluationSeconds, "number");
  assert.equal(result.evaluatorSetupSeconds, 0.25);
  assert.deepEqual((await readFile(lifecycle, "utf8")).trim().split("\n"), [
    "prepare",
    "wait",
    "agent",
    "agent",
    "evaluate",
    "cleanup",
  ]);
  const patch = await readFile(result.files.patch, "utf8");
  assert.match(patch, /export const value = 2/);
  assert.equal(
    execFileSync("git", ["show", "HEAD:value.js"], {
      cwd: repo,
      encoding: "utf8",
    }),
    "export const value = 1;\n",
  );
});

test("matched suites validate three modes and report per-task memory deltas", async () => {
  const root = await mkdtemp(join(tmpdir(), "louibot-benchmark-suite-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  await writeFile(join(repo, "value.js"), "export const value = 1;\n");
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const evaluator = join(root, "private-check.mjs");
  await writeFile(
    evaluator,
    "import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path'; const m=await import(pathToFileURL(join(process.cwd(),'value.js'))); assert.equal(m.value,2);",
  );
  const adapter = join(root, "adapter.mjs");
  await writeFile(
    adapter,
    "import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync('value.js','export const value = 2;\\n'); writeFileSync(process.env.BENCHMARK_RESULT_FILE,JSON.stringify({action:'implement',inputTokens:10,outputTokens:2,costUsd:0.01,budgetEnforced:false,toolCalls:1}));",
  );
  const casesDir = join(root, "cases");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(casesDir));
  const caseFiles = [];
  for (const mode of ["stateless", "code-map", "chronological-memory"]) {
    const value: Record<string, unknown> = {
      id: `same-issue-${mode}`,
      taskId: "same-issue",
      repository: "test/repo",
      repositoryPath: repo,
      baseCommit,
      prompt: "Set value to two.",
      mode,
      date: "2020-02-01",
      expectedFirstAction: "implement",
      evaluator: { commands: [`node '${evaluator}'`] },
    };
    if (mode === "chronological-memory") {
      value.memoryApproval = {
        approved: true,
        repository: "test/repo",
        sourceCaseIds: [],
        throughDate: "2020-01-01",
      };
      value.memory = [];
    }
    const name = `${mode}.json`;
    await writeFile(join(casesDir, name), JSON.stringify(value));
    caseFiles.push(name);
  }
  const suite = join(casesDir, "suite.json");
  await writeFile(suite, JSON.stringify({ cases: caseFiles }));
  const runRoot = join(process.cwd(), ".louibot/benchmarks/runs");
  const { readdir, rm: remove } = await import("node:fs/promises");
  const before = new Set(await readdir(runRoot).catch(() => []));
  const report = await runBenchmarkSuite(suite, `node '${adapter}'`, 15_000);
  for (const result of report.cases) runDirs.push(result.runDirectory);
  assert.equal(report.matchedTasks.length, 1);
  assert.equal(report.matchedTasks[0].complete, true);
  assert.equal(report.matchedTasks[0].memoryVsStateless.tokenUsage, 0);
  assert.equal(report.matchedSummary.completeTasks, 1);
  assert.equal(
    report.matchedSummary.perMode["chronological-memory"].resolved,
    1,
  );
  for (const file of await readdir(runRoot))
    if (!before.has(file) && file.startsWith("suite-"))
      await remove(join(runRoot, file), { force: true });
});

test("planning-only benchmark records review state and skips evaluator work", async () => {
  const root = await mkdtemp(join(tmpdir(), "louibot-benchmark-plan-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  await writeFile(join(repo, "value.js"), "export const value = 1;\n");
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const lifecycle = join(root, "evaluator-ran.txt");
  const agent = join(root, "agent.mjs");
  await writeFile(
    agent,
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.BENCHMARK_RESULT_FILE, JSON.stringify({action:'plan',planning:{problem:'Reported issue'},planningNotes:'Found relevant source file.',planningRevisionId:'plan-1',planningThreads:[{id:'thread-1',status:'open'}],planningReviewApproved:false,planningReportedBehaviors:[],investigationRounds:1,planningClefBlocks:2,inputTokens:10,outputTokens:2,costUsd:0.01,budgetEnforced:false,toolCalls:2}));`,
  );
  const caseFile = join(root, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "planning-only",
      repositoryPath: repo,
      baseCommit,
      prompt: "Plan a fix.",
      evaluator: {
        prepareCommand: `node -e "require('node:fs').writeFileSync('${lifecycle}','prepare')"`,
        commands: [
          `node -e "require('node:fs').writeFileSync('${lifecycle}','grade')"`,
        ],
        cleanupCommand: `node -e "require('node:fs').writeFileSync('${lifecycle}','cleanup')"`,
      },
    }),
  );
  const priorPlanningOnly = process.env.BENCHMARK_PLANNING_ONLY;
  process.env.BENCHMARK_PLANNING_ONLY = "1";
  try {
    const result = await runBenchmarkCase(caseFile, `node '${agent}'`, 10_000);
    runDirs.push(result.runDirectory);
    assert.equal(result.status, "planning-unapproved");
    assert.equal(result.behavior.planningReviewApproved, false);
    assert.deepEqual(result.behavior.planningReportedBehaviors, []);
    assert.equal(result.behavior.planningRevisionId, "plan-1");
    assert.equal(result.behavior.planningNotes, "Found relevant source file.");
    assert.equal(result.behavior.planningThreads[0].id, "thread-1");
    assert.equal(result.behavior.planningClefBlocks, 2);
    assert.deepEqual(result.evaluator, []);
    await assert.rejects(readFile(lifecycle));
  } finally {
    if (priorPlanningOnly === undefined)
      delete process.env.BENCHMARK_PLANNING_ONLY;
    else process.env.BENCHMARK_PLANNING_ONLY = priorPlanningOnly;
  }
});

test("approved planning report is verified and handed to implementation", async () => {
  const root = await mkdtemp(join(tmpdir(), "louibot-benchmark-handoff-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  await writeFile(join(repo, "value.js"), "export const value = 1;\n");
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const planReport = join(root, "plan-report.json");
  await writeFile(
    planReport,
    JSON.stringify({
      status: "planning-approved",
      taskId: "example/task-1",
      baseCommit,
      behavior: {
        planningReviewApproved: true,
        planningReportedBehaviors: [
          {
            quote: "The exported value is incorrect.",
            expectedOutcome: "The module exports 2.",
            planStepId: "step-1",
            validation: "Run the evaluator and observe value 2.",
          },
        ],
        planningRevisionId: "plan-2",
        planning: {
          problem: "The exported value is incorrect.",
          proposedExplanation: "The source exports the wrong value.",
          evidence: [
            {
              claim: "Source value",
              source: "value.js",
              observation: "It is 1.",
            },
          ],
          proposedChanges: [
            {
              id: "step-1",
              title: "Set value",
              description: "Change value.js to export 2.",
            },
          ],
          validationChecks: [
            {
              id: "check-1",
              command:
                "node -e \"import('./value.js').then(({value})=>{if(value!==2)process.exit(1)})\"",
              expectedOutcome: "The module exports 2.",
              reportedBehaviorQuotes: ["The exported value is incorrect."],
            },
          ],
          validation: "Run the evaluator and observe value 2.",
          openQuestions: [],
        },
        planningNotes: "value.js is the source.",
        planningEvidenceLedger: {
          discoverySummary: "Found the wrong value.",
          completedChecks: [],
          ruledOut: [],
          nextExperiment: "",
        },
        planningThreads: [{ id: "thread-1", status: "resolved" }],
        summary: "Approved plan-2.",
      },
    }),
  );
  const agent = join(root, "agent.mjs");
  await writeFile(
    agent,
    `import {readFileSync,writeFileSync} from 'node:fs'; const h=JSON.parse(readFileSync(process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE,'utf8')); if(h.revisionId!=='plan-2'||h.plan.problem!=='The exported value is incorrect.'||h.threads[0].id!=='thread-1'||h.reportedBehaviors[0].quote!=='The exported value is incorrect.') process.exit(7); writeFileSync('value.js','export const value = 2;\\n'); writeFileSync(process.env.BENCHMARK_RESULT_FILE,JSON.stringify({action:'implement',inputTokens:10,outputTokens:2,costUsd:0.01,budgetEnforced:false,toolCalls:1,implementationReviewApproved:true,implementationReviewRounds:1,implementationReviewThreads:[]}));`,
  );
  const caseFile = join(root, "case.json");
  await writeFile(
    caseFile,
    JSON.stringify({
      id: "handoff",
      taskId: "example/task-1",
      repositoryPath: repo,
      baseCommit,
      prompt: "Set value to two.",
      evaluator: {
        commands: [
          "node -e \"import('./value.js').then(({value})=>{if(value!==2)process.exit(1)})\"",
        ],
      },
    }),
  );
  const priorPlan = process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE;
  process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE = planReport;
  try {
    const result = await runBenchmarkCase(caseFile, `node '${agent}'`, 10_000);
    runDirs.push(result.runDirectory);
    assert.equal(result.status, "passed");
    assert.equal(result.behavior.implementationReviewApproved, true);
    assert.equal(result.behavior.implementationReviewRounds, 1);
  } finally {
    if (priorPlan === undefined)
      delete process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE;
    else process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE = priorPlan;
  }
});
