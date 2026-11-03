import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverSandboxImage,
  infrastructureValidationFailure,
  scopeValidationCommands,
  selectValidationCommands,
  serialValidationCommand,
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

test("planned validation checks replace generic discovery", () => {
  assert.deepEqual(
    selectValidationCommands({
      configured: [],
      planned: ["yarn jest packages/widget --runInBand"],
    }),
    ["yarn jest packages/widget --runInBand"],
  );
  assert.deepEqual(
    selectValidationCommands({
      configured: ["yarn lint"],
      planned: ["yarn jest packages/widget --runInBand"],
    }),
    ["yarn lint", "yarn jest packages/widget --runInBand"],
  );
  assert.deepEqual(
    selectValidationCommands({
      configured: [],
      planned: [],
    }),
    [],
  );
  assert.deepEqual(
    selectValidationCommands({
      configured: ["yarn lint"],
      planned: [],
    }),
    ["yarn lint"],
  );
});

test("bare test commands are scoped to changed workspace packages", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  await mkdir(join(root, "packages", "widget"), { recursive: true });
  await writeFile(
    join(root, "packages", "widget", "package.json"),
    JSON.stringify({ name: "widget" }),
  );
  assert.deepEqual(
    await scopeValidationCommands({
      root,
      diff: "diff --git a/packages/widget/src/index.ts b/packages/widget/src/index.ts\n",
      commands: ["yarn test", "yarn run build"],
    }),
    ["yarn test packages/widget", "yarn run build"],
  );
  assert.deepEqual(
    await scopeValidationCommands({
      root,
      diff: "diff --git a/docs/readme.md b/docs/readme.md\n",
      commands: ["yarn test"],
    }),
    ["yarn test"],
  );
});

test("infrastructure failures and serial retries are classified", () => {
  assert.equal(
    infrastructureValidationFailure(
      "failed to handle: The global thread pool has not been initialized.",
    ),
    true,
  );
  assert.equal(
    infrastructureValidationFailure("Error: Sandbox is not running"),
    true,
  );
  assert.equal(
    infrastructureValidationFailure("FAIL src/widget.test.ts: expected true"),
    false,
  );
  assert.equal(serialValidationCommand("yarn test"), "yarn test --runInBand");
  assert.equal(
    serialValidationCommand("yarn test --runInBand"),
    "yarn test --runInBand",
  );
  assert.equal(
    serialValidationCommand("pnpm vitest run"),
    "pnpm vitest run --maxWorkers=1",
  );
});
