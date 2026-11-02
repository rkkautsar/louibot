#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox, cacheVolumeName } from "../../dist/workspace.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "../..");
const CASE_IDS = new Set([
  "django__django-15315",
  "django__django-15863",
  "django__django-16493",
  "django__django-17087",
]);
const DEFAULT_DATASET = join(
  PROJECT_ROOT,
  ".louibot/benchmarks/django-baseline-20261021/prepared/private/dataset.json",
);
const DEFAULT_SOURCE = join(
  PROJECT_ROOT,
  ".louibot/benchmarks/django-baseline-20261021/django",
);
const SELECTION_FILE = join(SCRIPT_DIR, "django-12-selection.json");
const PARSER = join(SCRIPT_DIR, "grade_shared_case.py");
function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    if (key === "--help") {
      console.log(
        "Usage: BENCHMARK_CASE_ID=<id> BENCHMARK_PATCH_FILE=<file> node benchmarks/swe-verified/evaluate_shared_case.mjs --dataset <private-json> --runtime <runtime.json> [--image <image>] [--source <django-git-checkout>]",
      );
      process.exit(0);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
  }
  return args;
}

async function gitArchive(source, commit, destination) {
  const { stdout } = await execFileAsync("git", ["archive", "--format=tar", commit], {
    cwd: source,
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  const tarFile = join(dirname(destination), `${randomUUID()}.tar`);
  try {
    await writeFile(tarFile, stdout);
    await mkdir(destination, { recursive: true });
    await execFileAsync("tar", ["-xf", tarFile, "-C", destination]);
  } finally {
    await rm(tarFile, { force: true });
  }
}

function pathsInPatch(patch) {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]);
}

async function applyPatch(worktree, text, label) {
  if (!text.trim()) return;
  const file = join(worktree, `.shared-evaluation-${label}.patch`);
  try {
    await writeFile(file, text);
    await execFileAsync("git", ["apply", "--check", file], { cwd: worktree });
    await execFileAsync("git", ["apply", file], { cwd: worktree });
  } finally {
    await rm(file, { force: true });
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function restoreBaseTests(source, commit, paths, worktree) {
  for (const relativePath of paths) {
    const to = join(worktree, relativePath);
    await mkdir(dirname(to), { recursive: true });
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${commit}:${relativePath}`],
      { cwd: source, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    await writeFile(to, stdout);
  }
}

async function run() {
  const args = argsOf(process.argv.slice(2));
  const caseId = process.env.BENCHMARK_CASE_ID;
  const candidatePath = process.env.BENCHMARK_PATCH_FILE;
  if (!CASE_IDS.has(caseId)) throw new Error(`Unsupported BENCHMARK_CASE_ID: ${caseId ?? "<missing>"}`);
  if (!candidatePath) throw new Error("BENCHMARK_PATCH_FILE is required");
  if (!args.runtime) throw new Error("--runtime is required");

  const patchFile = resolve(candidatePath);
  const outputDir = join(dirname(patchFile), "shared-evaluation");
  await mkdir(outputDir, { recursive: true });
  const datasetPath = resolve(args.dataset ?? DEFAULT_DATASET);
  const sourcePath = resolve(args.source ?? DEFAULT_SOURCE);
  const selection = JSON.parse(await readFile(SELECTION_FILE, "utf8"));
  const runtimePath = resolve(args.runtime);
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const image = args.image ?? runtime.image;
  if (image !== runtime.image) {
    throw new Error(`--image must match frozen runtime image ${runtime.image}`);
  }
  if (!selection.instances.some((item) => item.id === caseId)) {
    throw new Error(`Case is absent from frozen selection metadata: ${caseId}`);
  }
  const rows = JSON.parse(await readFile(datasetPath, "utf8"));
  const row = rows.find((item) => item.instance_id === caseId);
  if (!row) throw new Error(`Private benchmark row not found: ${caseId}`);
  const candidatePatch = await readFile(patchFile, "utf8");
  const patchTestPaths = pathsInPatch(row.test_patch);
  const scratch = await mkdtemp(join(outputDir, `${caseId}-`));
  const worktree = join(scratch, "worktree");
  const runLog = join(outputDir, `${caseId}.test_output.txt`);
  const gradingInput = join(scratch, "grading-input.json");
  const gradingReport = join(outputDir, `${caseId}.report.json`);
  const sandboxKey = `shared-evaluation:${caseId}:${randomUUID()}`;
  const timeoutSeconds = Math.max(
    30,
    Math.min(600, Number(process.env.BENCHMARK_TIMEOUT_SECONDS) || runtime.commandTimeoutSeconds),
  );
  const setupCommand = runtime.setupCommands.join(" && ");
  let sandbox;
  let result;
  try {
    await gitArchive(sourcePath, row.base_commit, worktree);
    await execFileAsync("git", ["init", "--quiet"], { cwd: worktree });
    await applyPatch(worktree, candidatePatch, "candidate");
    await restoreBaseTests(sourcePath, row.base_commit, patchTestPaths, worktree);
    await applyPatch(worktree, row.test_patch, "heldout-tests");

    sandbox = new Sandbox(image, worktree, timeoutSeconds, () => {}, runtime.network ?? "bridge", sandboxKey);
    await sandbox.start();
    const command = row.eval_script
      .split("\n")
      .find((line) => /^\.\/tests\/runtests\.py /.test(line));
    if (!command) throw new Error(`Official Django test command missing for ${caseId}`);
    let setupOutput;
    try {
      setupOutput = await sandbox.shell(setupCommand);
    } catch (error) {
      const setupLog = join(outputDir, `${caseId}.setup_output.txt`);
      await writeFile(setupLog, String(error));
      await writeFile(
        gradingReport,
        `${JSON.stringify(
          {
            caseId,
            evaluationKind: "shared-runtime-task-tests",
            passed: false,
            failure: String(error),
            provenance: {
              dataset: datasetPath,
              baseCommit: row.base_commit,
              runtimeConfig: runtimePath,
              runtimeImage: image,
              setupCommand,
              setupOutput: setupLog,
            },
          },
          null,
          2,
        )}\n`,
      );
      throw error;
    }
    await writeFile(join(outputDir, `${caseId}.setup_output.txt`), setupOutput);
    const mountedLog = "/workspace/.shared-test-output.log";
    const stageLog = `${worktree}.sandbox/.shared-test-output.log`;
    let exitCode = 0;
    let shellFailure;
    try {
      await sandbox.shell(
        `set +e; PYTHONPATH=/workspace ${command} >${shellQuote(mountedLog)} 2>&1; runner_exit=$?; printf 'RUNNER_EXIT_CODE=%s\\n' "$runner_exit"; exit "$runner_exit"`,
      );
    } catch (error) {
      shellFailure = String(error);
      const match = String(error).match(/RUNNER_EXIT_CODE=(-?\d+)/);
      exitCode = match ? Number(match[1]) : 1;
    }
    let testOutput;
    try {
      testOutput = await readFile(stageLog, "utf8");
    } catch {
      testOutput = shellFailure ?? "Test command produced no output file.";
    }
    if (shellFailure && /timed out/i.test(shellFailure)) {
      testOutput = `>>>>> Tests Timed Out\\n${testOutput}`;
    }
    await rm(stageLog, { force: true });
    const completeLog = [
      ">>>>> Start Test Output",
      testOutput,
      ">>>>> End Test Output",
      `>>>>> Test Exit Code: ${exitCode}`,
    ].join("\n");
    await writeFile(runLog, completeLog);
    await writeFile(
      gradingInput,
      JSON.stringify({
        caseId,
        image,
        repo: row.repo,
        version: row.version,
        baseCommit: row.base_commit,
        FAIL_TO_PASS: row.FAIL_TO_PASS,
        PASS_TO_PASS: row.PASS_TO_PASS,
        logParser: row.log_parser,
        evalType: row.eval_type,
        testCommand: command,
        exitCode,
        testLogPath: runLog,
      }),
    );
    const { stdout } = await execFileAsync(
      "python3",
      [PARSER, gradingInput, gradingReport],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, PYTHONPATH: join(PROJECT_ROOT, ".louibot/benchmarks/django-python") },
        maxBuffer: 1024 * 1024,
      },
    );
    result = JSON.parse(stdout);
    result.evaluationKind = "shared-runtime-task-tests";
    result.provenance = {
      dataset: {
        path: datasetPath,
        name: selection.dataset,
        revision: selection.datasetRevision,
        split: selection.split,
      },
      selectionMetadata: SELECTION_FILE,
      sourceRepository: sourcePath,
      sourceSnapshot: "git archive at the row base commit (no .git history in evaluator checkout)",
      baseCommit: row.base_commit,
      officialTestCommand: command,
      runtimeConfig: runtimePath,
      setupCommand,
      expectedTests: {
        FAIL_TO_PASS: row.FAIL_TO_PASS.length,
        PASS_TO_PASS: row.PASS_TO_PASS.length,
      },
      parser: "bundled swebench.harness.grading.get_eval_report + parse_test_exit_code",
      runtimeImage: image,
      testOutput: runLog,
    };
    await writeFile(gradingReport, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (sandbox) {
      await sandbox.dispose();
      await execFileAsync("docker", ["volume", "rm", cacheVolumeName(sandboxKey)]).catch(() => {});
    }
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result?.passed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
