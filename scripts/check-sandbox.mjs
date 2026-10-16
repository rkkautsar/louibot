import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cacheVolumeName, Sandbox } from "../dist/workspace.js";
const parent = resolve(".louibot");
await mkdir(parent, { recursive: true });
const temp = await mkdtemp(`${parent}/smoke-`),
  worktree = `${temp}/workspace`;
const id = `louibot-${createHash("sha256").update(worktree).digest("hex").slice(0, 20)}`;
const cacheVolume = cacheVolumeName(worktree);
const box = new Sandbox("node:22", worktree, 120);
process.env.LOUIBOT_SMOKE_SECRET = "host-only-smoke-secret";
try {
  await mkdir(worktree);
  await writeFile(`${worktree}/.env`, "HOST_SECRET=do-not-mount");
  await writeFile(`${worktree}/.git`, "host-git-pointer");
  await writeFile(`${worktree}/delete-me.txt`, "old");
  await box.start();
  const settings = JSON.parse(
    execFileSync("docker", ["inspect", id], { encoding: "utf8" }),
  )[0];
  assert.equal(settings.HostConfig.ReadonlyRootfs, true);
  assert.equal(settings.HostConfig.NetworkMode, "bridge");
  assert.equal(settings.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(settings.HostConfig.PidsLimit, 256);
  assert.equal(settings.HostConfig.NanoCpus, 2e9);
  assert.ok(settings.HostConfig.CapDrop.includes("ALL"));
  assert.ok(settings.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.notEqual(settings.Config.User.split(":")[0], "0");
  console.log(
    "PASS: resource limits, unprivileged user, read-only root, capabilities",
  );
  await box.shell(
    `test ! -e /workspace/.env && test ! -e /workspace/.git && test ! -e /var/run/docker.sock && test -z "$LOUIBOT_SMOKE_SECRET" && test -z "$OPENAI_API_KEY" && test -z "$ANTHROPIC_API_KEY" && test -z "$CLOUDFLARE_API_TOKEN" && test -z "$GH_TOKEN" && test -z "$GITHUB_TOKEN"`,
  );
  console.log("PASS: host secrets, Git metadata, Docker socket excluded");
  await box.shell(
    "printf 'sandbox-ok' > result.txt; rm delete-me.txt; npm install --ignore-scripts --no-audit --no-fund is-number",
  );
  console.log("PASS: workspace edits and npm install over internet");
  await box.finish();
  await box.dispose();
  assert.equal(await readFile(`${worktree}/result.txt`, "utf8"), "sandbox-ok");
  await assert.rejects(access(`${worktree}/delete-me.txt`));
  assert.equal(
    await readFile(`${worktree}/.env`, "utf8"),
    "HOST_SECRET=do-not-mount",
  );
  await access(`${worktree}/node_modules/is-number/package.json`);
  await assert.rejects(access(`${worktree}.sandbox`));
  console.log(
    "PASS: changes persisted, deleted files removed, host secrets retained, staging cleaned",
  );
  const remaining = execFileSync(
    "docker",
    ["ps", "-a", "--filter", `name=^/${id}$`, "--format", "{{.Names}}"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(remaining, "", "Sandbox container leaked after finish/dispose");
  console.log("PASS: container cleanup");
} finally {
  await box.dispose();
  try {
    execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("docker", ["volume", "rm", cacheVolume], {
      stdio: "ignore",
    });
  } catch {}
  delete process.env.LOUIBOT_SMOKE_SECRET;
  await rm(temp, { recursive: true, force: true });
}
