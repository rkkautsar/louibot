#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const runDir = join(
  root,
  ".louibot/benchmarks/swe-multilingual-frontend-20261021",
);
const privateDir = join(runDir, "private");
const source = join(runDir, "source");
const datasetPath = join(privateDir, "dataset.json");
const runtime = JSON.parse(
  await readFile(join(runDir, "runtime.json"), "utf8"),
);
const allowed = new Set([
  "facebook__docusaurus-8927",
  "facebook__docusaurus-9183",
  "facebook__docusaurus-10130",
  "facebook__docusaurus-10309",
]);

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  return result.stdout;
}

async function tryRun(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
      timeout: options.timeout ?? 30 * 60 * 1000,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

async function rowFor(instanceId) {
  if (!allowed.has(instanceId))
    throw new Error(`Unsupported case: ${instanceId}`);
  const rows = JSON.parse(await readFile(datasetPath, "utf8"));
  const row = rows.find((item) => item.instance_id === instanceId);
  if (!row) throw new Error(`Missing private dataset row: ${instanceId}`);
  return row;
}

function pathsInPatch(patch) {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map(
    (match) => match[1],
  );
}

async function restoreBaseTestFiles(row, worktree) {
  for (const relativePath of pathsInPatch(row.test_patch)) {
    if (relativePath.startsWith("/") || relativePath.split("/").includes(".."))
      throw new Error(`Unsafe test path in dataset patch: ${relativePath}`);
    const output = join(worktree, relativePath);
    await mkdir(dirname(output), { recursive: true });
    const contents = await run(
      "git",
      ["show", `${row.base_commit}:${relativePath}`],
      {
        cwd: source,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    await writeFile(output, contents);
  }
}

async function applyPatch(worktree, patch, label) {
  const path = join(worktree, `.benchmark-${label}-${randomUUID()}.patch`);
  try {
    await writeFile(path, patch);
    await run("git", ["apply", "--check", path], { cwd: worktree });
    await run("git", ["apply", path], { cwd: worktree });
  } finally {
    await rm(path, { force: true });
  }
}

async function makeCacheWritable() {
  await run("docker", ["volume", "create", runtime.cacheVolume], {
    timeout: 30_000,
  });
  await run(
    "docker",
    [
      "run",
      "--rm",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--memory",
      "64m",
      "--cpus",
      "0.25",
      "--pids-limit",
      "64",
      "--mount",
      `type=volume,source=${runtime.cacheVolume},destination=/cache`,
      "--user",
      "0:0",
      "--entrypoint",
      "sh",
      runtime.image,
      "-lc",
      "chmod 0777 /cache",
    ],
    { timeout: 60_000 },
  );
}

function graderContainerName(worktree) {
  return `louibot-docusaurus-grade-${createHash("sha256")
    .update(resolve(worktree))
    .digest("hex")
    .slice(0, 16)}`;
}

async function startPreparedContainer(worktree) {
  if (process.env.BENCHMARK_CACHE_WARMED !== "1") await makeCacheWritable();
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const setup =
    "date +%s%3N > /workspace/.benchmark-runtime-started && mkdir -p /cache/corepack-bin && export COREPACK_HOME=/cache/corepack YARN_CACHE_FOLDER=/cache/yarn CI=1 PATH=/cache/corepack-bin:$PATH && corepack enable --install-directory /cache/corepack-bin && corepack prepare yarn@1.22.22 --activate >/dev/null && yarn install --frozen-lockfile --ignore-scripts --non-interactive --network-timeout 600000 --silent && yarn build:packages --concurrency 1 && date +%s%3N > /workspace/.benchmark-runtime-ready && exec tail -f /dev/null";
  const name = graderContainerName(worktree);
  await tryRun("docker", ["rm", "-f", name], { timeout: 30_000 });
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      name,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "bridge",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--mount",
      `type=bind,src=${resolve(worktree)},dst=/workspace`,
      "--mount",
      `type=volume,source=${runtime.cacheVolume},destination=/cache`,
      "--workdir",
      "/workspace",
      "--user",
      `${uid}:${gid}`,
      "--env",
      "HOME=/tmp",
      "--env",
      "XDG_CACHE_HOME=/cache/xdg",
      "--env",
      "NPM_CONFIG_CACHE=/cache/npm",
      "--env",
      "YARN_CACHE_FOLDER=/cache/yarn",
      "--env",
      "COREPACK_HOME=/cache/corepack",
      "--env",
      "PATH=/cache/corepack-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--entrypoint",
      "sh",
      runtime.image,
      "-lc",
      setup,
    ],
    { cwd: worktree, timeout: 60_000 },
  );
}

async function stopPreparedContainer(worktree) {
  await tryRun("docker", ["rm", "-f", graderContainerName(worktree)], {
    timeout: 30_000,
  });
}

async function waitForPreparedContainer(worktree, timeout = 30 * 60 * 1000) {
  const name = graderContainerName(worktree);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await tryRun(
      "docker",
      ["exec", name, "test", "-f", "/workspace/.benchmark-runtime-ready"],
      { timeout: 10_000 },
    );
    if (ready.exitCode === 0) return true;
    const running = await tryRun(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", name],
      { timeout: 10_000 },
    );
    if (running.exitCode || running.stdout.trim() !== "true") return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return false;
}

async function execPreparedTests(worktree, command) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return tryRun(
    "docker",
    [
      "exec",
      "--user",
      `${uid}:${gid}`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp",
      "--env",
      "XDG_CACHE_HOME=/cache/xdg",
      "--env",
      "NPM_CONFIG_CACHE=/cache/npm",
      "--env",
      "YARN_CACHE_FOLDER=/cache/yarn",
      "--env",
      "COREPACK_HOME=/cache/corepack",
      "--env",
      "PATH=/cache/corepack-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      graderContainerName(worktree),
      "sh",
      "-lc",
      command,
    ],
    { cwd: worktree, timeout: 30 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 },
  );
}

async function runTests(worktree, row, outputPath, install = true) {
  const commands = [
    ...row.eval_script.matchAll(
      /^\s*\(\s*(yarn\s+test\s+.+?)\s*\)\s*\|\s*cat\s*$/gm,
    ),
  ].map((match) => match[1].trim());
  if (
    !commands.length ||
    commands.some(
      (command) => !/^yarn test [\w./-]+(?:\s+--[\w-]+)*$/.test(command),
    )
  )
    throw new Error(
      `Official Jest command could not be safely extracted for ${row.instance_id}`,
    );

  const setup =
    "mkdir -p /cache/corepack-bin && export COREPACK_HOME=/cache/corepack YARN_CACHE_FOLDER=/cache/yarn CI=1 && corepack enable --install-directory /cache/corepack-bin && export PATH=/cache/corepack-bin:$PATH && corepack prepare yarn@1.22.22 --activate >/dev/null";
  const installCommand = install
    ? "yarn install --frozen-lockfile --ignore-scripts --non-interactive --network-timeout 600000 --silent && "
    : "";
  const prepared = !install && (await waitForPreparedContainer(worktree, 1000));
  if (prepared) {
    const result = await execPreparedTests(
      worktree,
      `${setup} && yarn build:packages --concurrency 1 && echo __DOCAURUS_TESTS_STARTED__ && ${commands.join(" && ")}`,
    );
    const output = `${result.stdout}\n${result.stderr}`;
    await writeFile(outputPath, output);
    return { ...result, outputPath, command: commands };
  }
  const fullCommand = `${setup} && ${installCommand}yarn build:packages --concurrency 1 && echo __DOCAURUS_TESTS_STARTED__ && ${commands.join(" && ")}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const result = await tryRun(
    "docker",
    [
      "run",
      "--rm",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "bridge",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--mount",
      `type=bind,src=${worktree},dst=/workspace`,
      "--mount",
      `type=volume,source=${runtime.cacheVolume},destination=/cache`,
      "--workdir",
      "/workspace",
      "--user",
      `${uid}:${gid}`,
      "--env",
      "HOME=/tmp",
      "--env",
      "XDG_CACHE_HOME=/cache/xdg",
      "--env",
      "NPM_CONFIG_CACHE=/cache/npm",
      "--env",
      "YARN_CACHE_FOLDER=/cache/yarn",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--entrypoint",
      "sh",
      runtime.image,
      "-lc",
      fullCommand,
    ],
    { cwd: worktree, timeout: 30 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  await writeFile(outputPath, output);
  return { ...result, outputPath, command: commands };
}

async function prepareCheckout(row, destination) {
  await mkdir(destination, { recursive: true });
  const tar = await run("git", ["archive", "--format=tar", row.base_commit], {
    cwd: source,
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  });
  const tarPath = `${destination}.tar`;
  try {
    await writeFile(tarPath, tar);
    await run("tar", ["-xf", tarPath, "-C", destination], {
      timeout: 5 * 60 * 1000,
    });
  } finally {
    await rm(tarPath, { force: true });
  }
  await run("git", ["init", "--quiet"], { cwd: destination });
  await run("git", ["config", "user.email", "benchmark@localhost"], {
    cwd: destination,
  });
  await run("git", ["config", "user.name", "Benchmark"], { cwd: destination });
  await run("git", ["add", "-A"], { cwd: destination, timeout: 5 * 60 * 1000 });
  await run("git", ["commit", "--quiet", "-m", `frozen ${row.instance_id}`], {
    cwd: destination,
    timeout: 5 * 60 * 1000,
  });
}

async function preflight(instanceId) {
  const row = await rowFor(instanceId);
  const dir = join(privateDir, "grader-check", instanceId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  await prepareCheckout(row, dir);
  const tests = join(dir, ".heldout-tests.patch");
  const logs = join(privateDir, "grader-check");
  const reportFile = join(logs, `${instanceId}.json`);
  try {
    await writeFile(tests, row.test_patch);
    await restoreBaseTestFiles(row, dir);
    await run("git", ["apply", "--check", tests], { cwd: dir });
    await run("git", ["apply", tests], { cwd: dir });
    await makeCacheWritable();
    const base = await runTests(
      dir,
      row,
      join(logs, `${instanceId}-base.log`),
      true,
    );
    await run("git", ["apply", "-R", tests], { cwd: dir });
    await applyPatch(dir, row.patch, "reference-fix");
    await restoreBaseTestFiles(row, dir);
    await run("git", ["apply", "--check", tests], { cwd: dir });
    await run("git", ["apply", tests], { cwd: dir });
    const gold = await runTests(
      dir,
      row,
      join(logs, `${instanceId}-gold.log`),
      false,
    );
    const baseOutput = `${base.stdout}\n${base.stderr}`;
    const baseFailures = row.FAIL_TO_PASS.filter((name) =>
      baseOutput
        .split("\n")
        .some((line) => /[✕×●]/.test(line) && line.includes(name)),
    );
    const report = {
      caseId: instanceId,
      baseCommit: row.base_commit,
      testPatchSha256: createHash("sha256")
        .update(row.test_patch)
        .digest("hex"),
      referencePatchSha256: createHash("sha256")
        .update(row.patch)
        .digest("hex"),
      baseExitCode: base.exitCode,
      goldExitCode: gold.exitCode,
      baseTestStarted: baseOutput.includes("__DOCAURUS_TESTS_STARTED__"),
      baseFailToPassFailures: baseFailures,
      expectedFailToPass: row.FAIL_TO_PASS,
      baseLog: base.outputPath,
      goldLog: gold.outputPath,
      verified:
        base.exitCode !== 0 &&
        baseOutput.includes("__DOCAURUS_TESTS_STARTED__") &&
        baseFailures.length === row.FAIL_TO_PASS.length &&
        gold.exitCode === 0,
    };
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    if (!report.verified) process.exitCode = 1;
  } finally {
    await rm(tests, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

async function evaluateCandidate(instanceId, worktree = process.cwd()) {
  const row = await rowFor(instanceId);
  const heldoutPath = join(worktree, `.heldout-tests-${randomUUID()}.patch`);
  const patchPaths = pathsInPatch(row.test_patch);
  const outputDir = join(
    dirname(resolve(process.env.BENCHMARK_PATCH_FILE)),
    "docusaurus-shared-evaluation",
  );
  await mkdir(outputDir, { recursive: true });
  const logPath = join(outputDir, `${instanceId}.test_output.txt`);
  const reportPath = join(outputDir, `${instanceId}.report.json`);
  try {
    await restoreBaseTestFiles(row, worktree);
    await writeFile(heldoutPath, row.test_patch);
    await run("git", ["apply", "--check", heldoutPath], { cwd: worktree });
    await run("git", ["apply", heldoutPath], { cwd: worktree });
    const prepared = await waitForPreparedContainer(worktree);
    if (!prepared) await makeCacheWritable();
    const result = await runTests(worktree, row, logPath, !prepared);
    const report = {
      caseId: instanceId,
      evaluationKind: "shared-runtime-task-tests",
      baseCommit: row.base_commit,
      testPatchSha256: createHash("sha256")
        .update(row.test_patch)
        .digest("hex"),
      testCommand: result.command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      output: result.outputPath,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } finally {
    await rm(heldoutPath, { force: true });
    await stopPreparedContainer(worktree);
  }
}

const args = process.argv.slice(2);
if (args[0] === "--init-cache") {
  await makeCacheWritable();
} else if (args[0] === "--preflight") {
  await preflight(args[1] ?? process.env.BENCHMARK_CASE_ID);
} else if (args[0] === "--prepare") {
  await rowFor(args[1] ?? process.env.BENCHMARK_CASE_ID);
  await startPreparedContainer(process.cwd());
} else if (args[0] === "--wait") {
  const worktree = process.cwd();
  if (!(await waitForPreparedContainer(worktree))) {
    const logs = await tryRun(
      "docker",
      ["logs", graderContainerName(process.cwd())],
      {
        timeout: 10_000,
      },
    );
    if (logs.stdout || logs.stderr)
      process.stderr.write(`${logs.stdout}${logs.stderr}`);
    await stopPreparedContainer(process.cwd());
    process.exitCode = 1;
  } else {
    const started = Number(
      await readFile(join(worktree, ".benchmark-runtime-started"), "utf8"),
    );
    const ready = Number(
      await readFile(join(worktree, ".benchmark-runtime-ready"), "utf8"),
    );
    console.log(JSON.stringify({ setupSeconds: (ready - started) / 1000 }));
  }
} else if (args[0] === "--cleanup") {
  await stopPreparedContainer(process.cwd());
} else if (args[0] === "--mini-patch") {
  const instanceId = args[1];
  const patchFile = resolve(args[2]);
  const row = await rowFor(instanceId);
  const dir = await mkdtemp(join(privateDir, `miniswe-grade-${instanceId}-`));
  const worktree = join(dir, "worktree");
  try {
    await prepareCheckout(row, worktree);
    const patch = await readFile(patchFile, "utf8");
    if (patch.trim()) await applyPatch(worktree, patch, "miniswe-candidate");
    process.env.BENCHMARK_CASE_ID = instanceId;
    process.env.BENCHMARK_PATCH_FILE = patchFile;
    await evaluateCandidate(instanceId, worktree);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  await evaluateCandidate(process.env.BENCHMARK_CASE_ID);
}
