import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadChecklistFile,
  saveChecklistFile,
  type ContractRequirement,
} from "../src/agent.js";

const requirement: ContractRequirement = {
  id: "req-1",
  quote: "The task states a behavior.",
  requirement: "Implement the stated behavior.",
  kind: "explicit",
};

test("checklist cache loads an entry saved with the same source hash", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "louibot-checklist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "checklist.json");
  await saveChecklistFile(path, [requirement], "hash-a");
  const loaded = await loadChecklistFile(path, "hash-a");
  assert.deepEqual(loaded, [requirement]);
});

test("checklist cache ignores an entry saved under a different source hash", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "louibot-checklist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "checklist.json");
  await saveChecklistFile(path, [requirement], "hash-a");
  assert.equal(await loadChecklistFile(path, "hash-b"), undefined);
});

test("checklist cache ignores an entry from another format version", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "louibot-checklist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "checklist.json");
  await writeFile(
    path,
    JSON.stringify({
      formatVersion: 999,
      sourceHash: "hash-a",
      requirements: [requirement],
    }),
  );
  assert.equal(await loadChecklistFile(path, "hash-a"), undefined);
});

test("checklist cache ignores missing or malformed files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "louibot-checklist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missing = join(dir, "missing.json");
  assert.equal(await loadChecklistFile(missing, "hash-a"), undefined);
  const malformed = join(dir, "malformed.json");
  await writeFile(malformed, "not json");
  assert.equal(await loadChecklistFile(malformed, "hash-a"), undefined);
});

test("checklist cache writes the source hash and format version", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "louibot-checklist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "checklist.json");
  await saveChecklistFile(path, [requirement], "hash-a");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    formatVersion?: number;
    sourceHash?: string;
  };
  assert.equal(raw.sourceHash, "hash-a");
  assert.equal(typeof raw.formatVersion, "number");
});
