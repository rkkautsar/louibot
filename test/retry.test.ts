import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store, type Job, type JobStatus } from "../src/store.js";

function fixture(status: JobStatus = "failed") {
  const dir = mkdtempSync(join(tmpdir(), "louibot-retry-"));
  const store = new Store(dir);
  const job: Job = {
    issue: 42,
    title: "Issue",
    body: "details",
    status,
    branch: "issue-42",
    worktree: "/tmp/issue-42",
    revision: 3,
    cost: 1.25,
    last: "before",
    events: ["event:1"],
    feedback: "failure",
    rounds: 2,
    errorCode: "EAI_AGAIN",
    error: "Temporary network failure",
    remediation: "Check network and retry",
  };
  store.save(job);
  return { dir, store, job };
}

test("retry rejects unknown issues and jobs that are active, waiting, or done", () => {
  const { dir, store } = fixture("coding");
  try {
    assert.throws(() => store.retry(99), /Unknown issue/);
    assert.throws(() => store.retry(42), /cannot be retried/);
    store.save({ ...store.all()[0], status: "clarification" });
    assert.throws(() => store.retry(42), /cannot be retried/);
    store.save({ ...store.all()[0], status: "done" });
    assert.throws(() => store.retry(42), /cannot be retried/);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry preserves accumulated job history and clears the stop flag", () => {
  const { dir, store, job } = fixture("stopped");
  try {
    store.stop(job.issue);
    const retried = store.retry(job.issue);
    assert.equal(store.stopped(job.issue), false);
    assert.equal(retried.status, "queued");
    assert.equal(retried.retryRequested, true);
    assert.equal(retried.cost, job.cost);
    assert.deepEqual(retried.events.slice(0, job.events.length), job.events);
    assert.match(retried.events.at(-1)!, /^retry:/);
    assert.equal(retried.worktree, job.worktree);
    assert.equal(retried.revision, job.revision);
    assert.equal(retried.rounds, job.rounds);
    assert.equal(retried.feedback, job.feedback);
    assert.equal(retried.error, undefined);
    assert.equal(retried.errorCode, undefined);
    assert.equal(retried.remediation, undefined);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop flag makes an interrupted job retryable", () => {
  const { dir, store, job } = fixture("coding");
  try {
    store.stop(job.issue);
    assert.equal(store.retry(job.issue).status, "queued");
    assert.equal(store.stopped(job.issue), false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered endpoint secrets are redacted from log data", () => {
  const { dir, store, job } = fixture();
  try {
    store.registerSecret("endpoint-secret-value");
    store.log(job.issue, "endpoint", { key: "endpoint-secret-value" });
    assert.match(
      readFileSync(join(dir, `${job.issue}.jsonl`), "utf8"),
      /\[REDACTED\]/,
    );
    assert.doesNotMatch(
      readFileSync(join(dir, `${job.issue}.jsonl`), "utf8"),
      /endpoint-secret-value/,
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
