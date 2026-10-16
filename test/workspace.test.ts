import { strict as assert } from "node:assert";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  copyWorkspaceToStage,
  syncWorkspaceFromStage,
} from "../src/workspace.js";

const roots: string[] = [];

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
  await writeFile(join(worktree, ".env"), "keep secret");
  await writeFile(join(worktree, "remove.txt"), "remove");
  await symlink(outside, join(worktree, "linked"));
  await writeFile(join(stage, "updated.txt"), "safe");

  await syncWorkspaceFromStage(stage, worktree);

  assert.equal(await readFile(join(worktree, ".env"), "utf8"), "keep secret");
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
