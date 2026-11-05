#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const datasetPath = join(
  root,
  ".louibot/benchmarks/swe-multilingual-preact-20261104/private/dataset.json",
);
const instanceId = process.env.BENCHMARK_CASE_ID;
const patchPath = process.env.BENCHMARK_PATCH_FILE;
if (!instanceId || !patchPath) {
  console.error("BENCHMARK_CASE_ID and BENCHMARK_PATCH_FILE are required");
  process.exit(2);
}
const rows = JSON.parse(readFileSync(datasetPath, "utf8"));
const row = rows.find((item) => item.instance_id === instanceId);
if (!row) throw new Error(`Missing dataset row: ${instanceId}`);

const short = (name) => name.split(" > ").at(-1).trim();
const expectedFail = row.FAIL_TO_PASS.map(short);
const expectedPass = row.PASS_TO_PASS.map(short);
const work = mkdtempSync(join(tmpdir(), "preact-eval-"));
const evalPath = join(work, "eval.sh");
const reportDir = join(dirname(resolve(patchPath)), "preact-evaluation");
mkdirSync(reportDir, { recursive: true });
writeFileSync(evalPath, row.eval_script);

const docker = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "bridge",
    "--memory",
    "4g",
    "--cpus",
    "2",
    "--pids-limit",
    "256",
    "--mount",
    `type=bind,src=${resolve(patchPath)},dst=/tmp/candidate.patch,readonly`,
    "--mount",
    `type=bind,src=${evalPath},dst=/tmp/eval.sh,readonly`,
    row.image,
    "bash",
    "-lc",
    "cd /testbed && git apply /tmp/candidate.patch && bash /tmp/eval.sh",
  ],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 1800_000 },
);
const output = `${docker.stdout ?? ""}\n${docker.stderr ?? ""}`;
writeFileSync(join(reportDir, `${instanceId}.test_output.txt`), output);
const missingFailToPass = expectedFail.filter(
  (name) => !output.includes(`✔ ${name}`),
);
const failedPassToPass = expectedPass.filter((name) =>
  output.includes(`✖ ${name}`),
);
const passed =
  docker.status === 0 &&
  missingFailToPass.length === 0 &&
  failedPassToPass.length === 0;
const report = {
  caseId: instanceId,
  evaluationKind: "swebench-official-image",
  image: row.image,
  exitCode: docker.status,
  passed,
  missingFailToPass,
  failedPassToPass,
  testOutput: join(reportDir, `${instanceId}.test_output.txt`),
};
writeFileSync(
  join(reportDir, `${instanceId}.report.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
process.exit(passed ? 0 : 1);
