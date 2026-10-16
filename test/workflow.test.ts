import assert from "node:assert/strict";
import test from "node:test";
import { commitSubject, issuePhase } from "../src/workflow.js";
import type { Job, JobStatus } from "../src/store.js";

function job(status: JobStatus, outcome?: Job["outcome"]): Job {
  return {
    issue: 1,
    title: "Issue",
    body: "",
    status,
    branch: "louibot/issue-1",
    worktree: "/tmp/issue-1",
    revision: 0,
    cost: 0,
    last: "",
    events: [],
    feedback: "",
    rounds: 0,
    outcome,
  };
}

test("active and review states keep the active issue label", () => {
  for (const status of ["coding", "queued", "review"]) {
    assert.equal(issuePhase(job(status)), "ready", status);
  }
});

test("clarification, failures, and explicit stops use the blocked label", () => {
  for (const status of ["clarification", "failed"]) {
    assert.equal(issuePhase(job(status)), "blocked", status);
  }
  assert.equal(issuePhase(job("queued"), true), "blocked");
});

test("only a merged completion gets the done label", () => {
  assert.equal(issuePhase(job("done", "merged")), "done");
  assert.equal(issuePhase(job("done", "closed")), "closed");
  assert.equal(issuePhase(job("done")), "closed");
});

test("commit subjects use model intent, one issue reference, and one line", () => {
  assert.equal(
    commitSubject(
      12,
      "Fix retry handling for #12\nwithout losing state",
      "summary",
    ),
    "Fix retry handling for without losing state (#12)",
  );
  assert.equal(
    commitSubject(
      12,
      "Add preview whitespace regression tests (#12)",
      "summary",
    ),
    "Add preview whitespace regression tests (#12)",
  );
  assert.equal(
    commitSubject(12, "Fix\u0000\u001b terminal output", "summary"),
    "Fix terminal output (#12)",
  );
  assert.equal(
    commitSubject(12, undefined, "Clarify retry behavior after a restart"),
    "Clarify retry behavior after a restart (#12)",
  );
  assert.equal(commitSubject(12, "  \n ", ""), "Update implementation (#12)");
  const longIssueSubject = commitSubject(
    1234567890123456,
    "A".repeat(100),
    "summary",
  );
  assert.ok(Array.from(longIssueSubject).length <= 70);
  assert.equal(longIssueSubject.endsWith(" (#1234567890123456)"), true);
});
