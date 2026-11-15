#!/usr/bin/env node
// DeepSWE v1.1 evaluator for Louibot's benchmark harness.
// Env: BENCHMARK_CASE_ID = DeepSWE task name, BENCHMARK_PATCH_FILE = candidate patch.
// Exit: 0 passed, 1 failed, 2 inconclusive (missing reward / infrastructure error).
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const subset = join(root, ".louibot", "benchmarks", "deepswe-subset-20261115", "tasks");
const caseId = process.env.BENCHMARK_CASE_ID;
const patchFile = process.env.BENCHMARK_PATCH_FILE;
if (!caseId || !patchFile) {
  console.error("BENCHMARK_CASE_ID and BENCHMARK_PATCH_FILE are required");
  process.exit(2);
}

const taskDir = join(subset, caseId);
const verifierDir = join(taskDir, "verifier");
const taskToml = await readFile(join(taskDir, "task.toml"), "utf8");
const image = /docker_image\s*=\s*"([^"]+)"/.exec(taskToml)?.[1];
if (!image) {
  console.error(`no docker_image in ${taskDir}/task.toml`);
  process.exit(2);
}

const verifierImage = `deepswe-verifier-${caseId}`.toLowerCase();
// Serialize verifier runs: each spawns a full jest/mocha suite, and this host
// has ~5 GB free while two agent sandboxes are alive.
const LOCK = join(tmpdir(), "deepswe-verifier.lock");

const run = (args, timeout = 30 * 60 * 1000) =>
  execFileSync("flock", [LOCK, "docker", ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

// Build the verifier image once per task (task image + hidden tests baked in).
try {
  execFileSync("docker", ["image", "inspect", verifierImage], {
    stdio: "ignore",
    timeout: 60_000,
  });
} catch {
  console.error(`building ${verifierImage} from ${verifierDir}`);
  execFileSync(
    "docker",
    ["build", "-q", "-t", verifierImage, "-f", join(verifierDir, "Dockerfile"), verifierDir],
    { encoding: "utf8", timeout: 30 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"] },
  );
}

const dir = await mkdtemp(join(tmpdir(), "deepswe-eval-"));
await mkdir(join(dir, "artifacts"), { recursive: true });
await mkdir(join(dir, "verifier"), { recursive: true });
await writeFile(join(dir, "artifacts", "model.patch"), await readFile(patchFile));

let stdout = "";
let stderr = "";
let code = 0;
const verifierStarted = Date.now();
try {
  stdout = run([
    "run",
    "--rm",
    "--network",
    "none",
    "--memory",
    "4096m",
    "-v",
    `${dir}:/logs`,
    verifierImage,
    "bash",
    "/tests/test.sh",
  ]);
} catch (error) {
  stdout = String(error?.stdout ?? "");
  stderr = String(error?.stderr ?? error?.message ?? error);
  code = typeof error?.status === "number" ? error.status : 1;
}

const verifierMs = Date.now() - verifierStarted;

await writeFile(join(dir, "verifier", "test-stdout.txt"), stdout + (stderr ? `\n${stderr}` : ""));

let reward = null;
try {
  reward = JSON.parse(await readFile(join(dir, "verifier", "reward.json"), "utf8"));
} catch {}

let ctrf = null;
try {
  ctrf = JSON.parse(await readFile(join(dir, "verifier", "ctrf.json"), "utf8"));
} catch {}
const tests = Array.isArray(ctrf?.results?.tests) ? ctrf.results.tests : [];
// A crashed suite can still emit a JUnit report where every testcase has
// time="0" while the suite itself took seconds. Treat that as a crash.
let zeroJunit = false;
try {
  const reportsDir = join(dir, "verifier", "reports");
  for (const name of await readdir(reportsDir)) {
    if (!name.endsWith(".xml")) continue;
    const xml = await readFile(join(reportsDir, name), "utf8");
    const suiteTime = Number(
      /<testsuite\b[^>]*\btime="([\d.]+)"/.exec(xml)?.[1] ?? 0,
    );
    const cases = [...xml.matchAll(/<testcase\b[^>]*\btime="([\d.]+)"/g)].map(
      (match) => Number(match[1]),
    );
    if (cases.length > 0 && cases.every((time) => time === 0) && suiteTime === 0)
      zeroJunit = true;
  }
} catch {}
const crashText = /heap out of memory|Worker exited unexpectedly|FATAL ERROR/i.test(
  stdout + stderr,
);
const passedWithoutTests = reward?.reward === 1 && tests.length === 0;
const crashDetected =
  crashText ||
  (zeroJunit && verifierMs > 10_000) ||
  passedWithoutTests;
const complete = reward !== null && !reward.apply_failed && !crashDetected;
const passed = complete && reward.reward === 1;
const report = {
  caseId,
  evaluationKind: "deepswe-v1.1-official-tests",
  image,
  verifierImage,
  exitCode: code,
  passed: complete ? passed : null,
  complete,
  reward: reward?.reward ?? null,
  applyFailed: reward?.apply_failed === 1,
  f2p: reward ? { passed: reward.f2p_passed, total: reward.f2p_total } : null,
  p2p: reward ? { passed: reward.p2p_passed, total: reward.p2p_total } : null,
  partial: reward?.partial ?? null,
  crashDetected,
  error: complete
    ? null
    : crashDetected
      ? `verifier suite crashed or produced zero-duration results (exit ${code})`
      : code !== 0
        ? stderr.slice(-2000)
        : "missing reward.json",
  testOutput: join(dir, "verifier", "test-stdout.txt"),
};
console.log(JSON.stringify(report));
process.exit(complete ? (passed ? 0 : 1) : 2);
