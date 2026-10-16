import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverSandboxImage,
  discoverValidationCommands,
} from "../src/discovery.js";

const temporary = new Set<string>();

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "louibot-discovery-"));
  temporary.add(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all(
    [...temporary].map((root) => rm(root, { recursive: true, force: true })),
  );
  temporary.clear();
});

test("sandbox discovery prefers devcontainer images and supports explicit overrides", async () => {
  const root = await fixture();
  await mkdir(join(root, ".devcontainer"));
  await writeFile(
    join(root, ".devcontainer", "devcontainer.json"),
    '{\n  "image": "python:3.13",\n  // comments are allowed\n}',
  );
  assert.deepEqual(await discoverSandboxImage(root, "auto"), {
    image: "python:3.13",
    source: "devcontainer.json",
  });
  assert.deepEqual(await discoverSandboxImage(root, "golang:1.25"), {
    image: "golang:1.25",
    source: "configuration",
  });
});

test("sandbox discovery selects a common image from repository files", async () => {
  const root = await fixture();
  await writeFile(join(root, "go.mod"), "module example.com/demo\n");
  assert.deepEqual(await discoverSandboxImage(root, "auto"), {
    image: "golang:1.25",
    source: "go.mod",
  });
});

test("validation discovery uses repository-native commands", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  assert.deepEqual(await discoverValidationCommands(root), [
    "pnpm test",
    "pnpm run build",
  ]);
});
