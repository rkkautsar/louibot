import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  cacheVolumeName,
  buildShellCaptureCommand,
  copyWorkspaceToStage,
  prepareSandboxStage,
  Sandbox,
  MAX_SHELL_OUTPUT,
  syncWorkspaceFromStage,
  truncateShellOutput,
} from "../src/workspace.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

test("cache volumes are stable and safe for repository identifiers", () => {
  const first = cacheVolumeName("owner/repo");
  assert.equal(first, cacheVolumeName("owner/repo"));
  assert.notEqual(first, cacheVolumeName("other/repo"));
  assert.match(first, /^louibot-build-cache-[a-f0-9]{24}$/);
});

test("sandbox leaves /tmp uncapped and shares Playwright browsers in /cache", async () => {
  const { root, worktree } = await fixture();
  const bin = join(root, "bin");
  const dockerLog = join(root, "docker-args.log");
  await mkdir(bin);
  const fakeDocker = join(bin, "docker");
  await writeFile(
    fakeDocker,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOUIBOT_TEST_DOCKER_LOG"\n',
  );
  await chmod(fakeDocker, 0o755);

  const originalPath = process.env.PATH;
  const originalDockerLog = process.env.LOUIBOT_TEST_DOCKER_LOG;
  try {
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.LOUIBOT_TEST_DOCKER_LOG = dockerLog;
    const sandbox = new Sandbox("node:22", worktree, 120);
    await sandbox.start();
    await sandbox.dispose();

    const dockerArgs = await readFile(dockerLog, "utf8");
    assert.match(dockerArgs, /--tmpfs \/tmp:rw,nosuid,nodev/);
    assert.doesNotMatch(dockerArgs, /size=64m/);
    assert.match(dockerArgs, /PLAYWRIGHT_BROWSERS_PATH=\/cache\/playwright/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDockerLog === undefined)
      delete process.env.LOUIBOT_TEST_DOCKER_LOG;
    else process.env.LOUIBOT_TEST_DOCKER_LOG = originalDockerLog;
  }
});

test("shell output keeps both the beginning and end when truncated", () => {
  const output = `${"head ".repeat(10_000)}${"tail ".repeat(10_000)}`;
  const truncated = truncateShellOutput(output);
  assert.ok(truncated.length <= MAX_SHELL_OUTPUT);
  assert.match(truncated, /^head /);
  assert.match(truncated, /tail $/);
  assert.match(truncated, /output truncated by Louibot/);
});

test("large shell output leaves an agent-readable sandbox file", () => {
  const command = buildShellCaptureCommand("printf 'hello'", "/tmp/output.log");
  assert.match(command, /eval/);
  assert.match(command, /hello/);
  assert.match(command, /\/tmp\/output\.log/);
  assert.doesNotMatch(command, /ulimit -f/);
  assert.match(command, /full output:/);
});

test("shell capture does not limit files written by the command", async () => {
  const { root } = await fixture();
  const largeFile = join(root, "large-package.bin");
  const outputFile = join(root, "command-output.log");
  const result = await execFileAsync("sh", [
    "-lc",
    buildShellCaptureCommand(
      `dd if=/dev/zero of='${largeFile}' bs=1048576 count=10 status=none && printf 'installed'`,
      outputFile,
    ),
  ]);

  assert.equal(result.stdout, "installed");
  assert.equal((await stat(largeFile)).size, 10 * 1024 * 1024);
});

test("incomplete sandbox stage is rebuilt before it can overwrite the worktree", async () => {
  const { root, worktree } = await fixture();
  const stage = join(root, "worktree.sandbox");
  await writeFile(join(worktree, "preserve.txt"), "host copy");
  await mkdir(stage);
  await writeFile(join(stage, "preserve.txt"), "partial stale copy");
  await writeFile(`${stage}.tmp`, "stale temporary data");

  await prepareSandboxStage(worktree, stage);
  await writeFile(join(stage, "agent-change.txt"), "agent output");
  await prepareSandboxStage(worktree, stage);

  assert.equal(
    await readFile(join(stage, "preserve.txt"), "utf8"),
    "host copy",
  );
  assert.equal(
    await readFile(join(stage, "agent-change.txt"), "utf8"),
    "agent output",
  );
  await assert.rejects(readFile(`${stage}.tmp`));
  assert.equal(
    await readFile(`${stage}.complete`, "utf8"),
    "louibot-stage-v1\n",
  );
});

async function fixture(): Promise<{
  root: string;
  stage: string;
  worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "louibot-sync-test-"));
  roots.push(root);
  const stage = join(root, "stage");
  const worktree = join(root, "worktree");
  await mkdir(stage);
  await mkdir(worktree);
  return { root, stage, worktree };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("sync copies staged changes and applies file and directory deletions", async () => {
  const { stage, worktree } = await fixture();
  await mkdir(join(stage, "nested"));
  await writeFile(join(stage, "nested", "new.txt"), "new");
  await writeFile(join(worktree, "remove.txt"), "remove");
  await mkdir(join(worktree, "old-dir"));
  await writeFile(join(worktree, "old-dir", "old.txt"), "old");

  await syncWorkspaceFromStage(stage, worktree);

  assert.equal(
    await readFile(join(worktree, "nested", "new.txt"), "utf8"),
    "new",
  );
  await assert.rejects(readFile(join(worktree, "remove.txt")));
  await assert.rejects(readFile(join(worktree, "old-dir", "old.txt")));
});

test("sync preserves protected files and never follows host symlinks", async () => {
  const { root, stage, worktree } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "outside data");
  const protectedFiles = [
    ".env",
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".git-credentials",
    "credentials.json",
    "secrets.json",
    "application_default_credentials.json",
  ];
  for (const file of protectedFiles)
    await writeFile(join(worktree, file), `keep ${file}`);
  await mkdir(join(worktree, ".config", "gcloud"), { recursive: true });
  await writeFile(
    join(worktree, ".config", "gcloud", "application_default_credentials.json"),
    "keep gcloud credentials",
  );
  await mkdir(join(worktree, ".docker"));
  await writeFile(
    join(worktree, ".docker", "config.json"),
    "keep docker credentials",
  );
  await writeFile(join(worktree, "remove.txt"), "remove");
  await symlink(outside, join(worktree, "linked"));
  await writeFile(join(stage, "updated.txt"), "safe");

  await syncWorkspaceFromStage(stage, worktree);

  for (const file of protectedFiles)
    assert.equal(await readFile(join(worktree, file), "utf8"), `keep ${file}`);
  assert.equal(
    await readFile(
      join(
        worktree,
        ".config",
        "gcloud",
        "application_default_credentials.json",
      ),
      "utf8",
    ),
    "keep gcloud credentials",
  );
  assert.equal(
    await readFile(join(worktree, ".docker", "config.json"), "utf8"),
    "keep docker credentials",
  );
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "outside data",
  );
  assert.equal(await readFile(join(worktree, "updated.txt"), "utf8"), "safe");
  await assert.rejects(readFile(join(worktree, "remove.txt")));
  await assert.rejects(readFile(join(worktree, "linked")));
});

test("sync and stage copying preserve safe relative tool links and omit escaping or protected links", async () => {
  const { root, stage, worktree } = await fixture();
  const outside = join(root, "outside");
  await mkdir(join(stage, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(stage, "node_modules", "vite", "bin"), { recursive: true });
  await mkdir(join(stage, "links"), { recursive: true });
  await mkdir(outside);
  await writeFile(
    join(stage, "node_modules", "vite", "bin", "vite.js"),
    "tool",
  );
  await writeFile(join(outside, "sentinel"), "host data");
  await symlink(
    "../vite/bin/vite.js",
    join(stage, "node_modules", ".bin", "vite"),
  );
  await symlink(join(outside, "sentinel"), join(stage, "links", "absolute"));
  await symlink("../../outside/sentinel", join(stage, "links", "escaping"));
  await symlink("../.git/config", join(stage, "links", "git"));
  await symlink("../.env", join(stage, "links", "secret"));

  await syncWorkspaceFromStage(stage, worktree);
  assert.equal(
    await readlink(join(worktree, "node_modules", ".bin", "vite")),
    "../vite/bin/vite.js",
  );
  await assert.rejects(readlink(join(worktree, "links", "absolute")));
  await assert.rejects(readlink(join(worktree, "links", "escaping")));
  await assert.rejects(readlink(join(worktree, "links", "git")));
  await assert.rejects(readlink(join(worktree, "links", "secret")));
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "host data");

  const copied = join(root, "copied-stage");
  await mkdir(copied);
  await copyWorkspaceToStage(worktree, copied);
  assert.equal(
    await readlink(join(copied, "node_modules", ".bin", "vite")),
    "../vite/bin/vite.js",
  );
});
