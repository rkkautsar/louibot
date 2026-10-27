import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBenchmarkCase } from "../src/benchmark.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "louibot-bench-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "value.txt"), "1\n");
  await writeFile(join(repo, "public-test.mjs"), "process.exit(1);\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseCommit = git("rev-parse", "HEAD");
  const checker = join(root, "private-check.mjs");
  await writeFile(
    checker,
    "import {readFileSync} from 'node:fs'; if(readFileSync('value.txt','utf8')!=='2\\n') process.exit(1);",
  );
  const manifest = {
    id: "boundary",
    repositoryPath: repo,
    repository: "test/repo",
    baseCommit,
    prompt: "Change value to two.",
    evaluator: { commands: [`node '${checker}'`] },
  };
  async function run(
    source: string,
    extra: Record<string, unknown> = {},
    timeout = 10000,
  ) {
    const adapter = join(root, "adapter.mjs");
    await writeFile(adapter, source);
    const file = join(root, "case.json");
    await writeFile(file, JSON.stringify({ ...manifest, ...extra }));
    const report = await runBenchmarkCase(file, `node '${adapter}'`, timeout);
    t.after(() => rm(report.runDirectory, { recursive: true, force: true }));
    return report;
  }
  return { root, repo, git, run };
}

test("base snapshot cannot read later commit objects", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "future-secret.txt"), "future solution");
  f.git("add", ".");
  f.git("commit", "-qm", "future");
  const future = f.git("rev-parse", "HEAD");
  const report = await f.run(
    `import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; let leaked=false; try{execFileSync('git',['cat-file','-e','${future}^{commit}'],{stdio:'ignore'});leaked=true;}catch{} if(leaked)process.exit(2);writeFileSync('value.txt','2\\n');`,
  );
  assert.equal(report.status, "passed");
  assert.equal(report.tokenUsage, null);
  assert.equal(report.costUsd, null);
});

test("editing a visible test cannot satisfy the independent hidden evaluator", async (t) => {
  const f = await fixture(t);
  const report = await f.run(
    "import {writeFileSync} from 'node:fs'; writeFileSync('public-test.mjs','process.exit(0);');",
  );
  assert.equal(report.status, "failed");
  assert.equal(report.evaluator[0].exitCode, 1);
});

test("only approved prior repository memory enters the task", async (t) => {
  const f = await fixture(t);
  const report = await f.run(
    "import {readFileSync,writeFileSync} from 'node:fs'; const task=readFileSync(process.env.BENCHMARK_PROMPT_FILE,'utf8');if(!task.includes('VETTED_PRIOR')||/FUTURE_LEAK|SELF_LEAK|OTHER_REPO/.test(task))process.exit(2);writeFileSync('value.txt','2\\n');",
    {
      mode: "chronological-memory",
      date: "2020-02-01",
      memoryApproval: {
        approved: true,
        repository: "test/repo",
        sourceCaseIds: ["prior", "future", "boundary", "other"],
        throughDate: "2020-01-15",
      },
      memory: [
        {
          date: "2020-01-01",
          sourceCaseId: "prior",
          repository: "test/repo",
          text: "VETTED_PRIOR",
        },
        {
          date: "2020-03-01",
          sourceCaseId: "future",
          repository: "test/repo",
          text: "FUTURE_LEAK",
        },
        {
          date: "2020-01-01",
          sourceCaseId: "boundary",
          repository: "test/repo",
          text: "SELF_LEAK",
        },
        {
          date: "2020-01-01",
          sourceCaseId: "other",
          repository: "other/repo",
          text: "OTHER_REPO",
        },
      ],
    },
  );
  assert.equal(report.status, "passed");
});

test("a hung agent is terminated and cannot pass evaluation", async (t) => {
  const f = await fixture(t);
  const start = Date.now();
  const report = await f.run("setInterval(()=>{},1000);", {}, 150);
  assert.equal(report.status, "agent-failed");
  assert.ok(Date.now() - start < 5000);
});

test("invalid runtime limits are rejected before any agent is started", async () => {
  await assert.rejects(
    () => runBenchmarkCase("missing.json", "ignored", Number.NaN),
    /positive finite/,
  );
  await assert.rejects(
    () => runBenchmarkCase("missing.json", "ignored", 0),
    /positive finite/,
  );
});
