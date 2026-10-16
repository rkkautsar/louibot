import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store, type Job } from "../src/store.js";

function temporaryStore(): { dir: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "louibot-store-"));
  return { dir, store: new Store(dir) };
}

function job(issue: number): Job {
  return {
    issue,
    title: `Issue ${issue}`,
    body: "details",
    status: "queued",
    branch: `issue-${issue}`,
    worktree: `/tmp/issue-${issue}`,
    revision: 1,
    cost: 0,
    last: "",
    events: [],
    feedback: "",
    rounds: 0,
  };
}

test("claim inserts a job once", () => {
  const { dir, store } = temporaryStore();
  try {
    assert.equal(store.claim(job(12)), true);
    assert.equal(store.claim({ ...job(12), title: "duplicate" }), false);
    assert.equal(store.all().length, 1);
    assert.equal(store.all()[0].title, "Issue 12");
    assert.deepEqual(store.get(12), job(12));
    assert.equal(store.get(13), undefined);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jobs and stop flags persist after reopening", () => {
  const { dir, store } = temporaryStore();
  try {
    store.save(job(24));
    store.stop(24);
    store.db.close();

    const reopened = new Store(dir);
    try {
      assert.deepEqual(reopened.all(), [job(24)]);
      assert.equal(reopened.stopped(24), true);
      assert.equal(reopened.stopped(25), false);
    } finally {
      reopened.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log redacts configured secrets and common token formats", () => {
  const { dir, store } = temporaryStore();
  const oldSecret = process.env.LOUIBOT_TEST_SECRET;
  const fakeGithubToken = [
    "gh",
    "p_",
    "abcdefghijklmnopqrstuvwxyz1234567890",
  ].join("");
  const fakeOpenAiToken = [
    "s",
    "k-",
    "abcdefghijklmnopqrstuvwxyz1234567890",
  ].join("");
  const tokenPattern = new RegExp(
    `${["gh", "p_"].join("")}[A-Za-z0-9_]+|${["s", "k-"].join("")}[A-Za-z0-9_-]+`,
  );
  process.env.LOUIBOT_TEST_SECRET = "very-secret-value";
  try {
    store.log(31, "event", {
      configured: "very-secret-value",
      github: fakeGithubToken,
      openai: fakeOpenAiToken,
    });
    const contents = readFileSync(join(dir, "31.jsonl"), "utf8");
    assert.doesNotMatch(
      contents,
      new RegExp(`very-secret-value|${tokenPattern.source}`),
    );
    assert.equal((contents.match(/\[REDACTED\]/g) ?? []).length, 3);
  } finally {
    if (oldSecret === undefined) delete process.env.LOUIBOT_TEST_SECRET;
    else process.env.LOUIBOT_TEST_SECRET = oldSecret;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
