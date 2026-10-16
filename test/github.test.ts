import assert from "node:assert/strict";
import test from "node:test";
import { GitHub } from "../src/github.js";

type MockRun = (args: string[]) => string | Promise<string>;

function client(run: MockRun): GitHub {
  const github = new GitHub("owner/repo");
  // Replace the HTTP boundary so these tests exercise public API methods
  // without network access or credentials.
  Object.defineProperty(github, "api", {
    value: async (
      endpoint: string,
      options: { method?: string; body?: unknown } = {},
    ) => {
      const output = await run([
        options.method ?? "GET",
        endpoint,
        ...(options.body === undefined ? [] : [JSON.stringify(options.body)]),
      ]);
      return output ? JSON.parse(output) : undefined;
    },
  });
  return github;
}

test("issues flatten paginated results and exclude pull requests", async () => {
  const calls: string[][] = [];
  const github = client((args) => {
    calls.push(args);
    return JSON.stringify([
      { number: 1, title: "Issue", body: "" },
      { number: 2, title: "PR", body: "", pull_request: { url: "..." } },
    ]);
  });

  assert.deepEqual(await github.issues("good first issue"), [
    { number: 1, title: "Issue", body: "" },
  ]);
  assert.deepEqual(calls[0], [
    "GET",
    "repos/owner/repo/issues?state=open&labels=good%20first%20issue&per_page=100&page=1",
  ]);
});

test("authorization allows write roles and fails closed on lookup errors", async () => {
  const github = client((args) => {
    if (args[1].includes("viewer"))
      return JSON.stringify({ permission: "read" });
    if (args[1].includes("maintainer"))
      return JSON.stringify({ permission: "maintain" });
    if (args[1].includes("missing")) throw new Error("HTTP 404 Not Found");
    return JSON.stringify({ permission: "write" });
  });

  assert.equal(await github.authorized("writer"), true);
  assert.equal(await github.authorized("maintainer"), true);
  assert.equal(await github.authorized("viewer"), false);
  assert.equal(await github.authorized("missing"), false);
});

test("reviews attach inline comments by review id and preserve line numbers", async () => {
  const github = client((args) => {
    const endpoint = args[1];
    if (endpoint.includes("/reviews?")) {
      return JSON.stringify([
        {
          id: 10,
          state: "CHANGES_REQUESTED",
          body: "Fix this",
          user: { login: "reviewer" },
        },
      ]);
    }
    return JSON.stringify([
      {
        id: 20,
        pull_request_review_id: 10,
        path: "src/a.ts",
        line: 7,
        body: "Inline note",
      },
      {
        id: 21,
        pull_request_review_id: 11,
        path: "src/b.ts",
        line: null,
        body: "Other review",
      },
    ]);
  });

  assert.deepEqual(await github.reviews(5), [
    {
      id: 10,
      state: "CHANGES_REQUESTED",
      body: "Fix this",
      user: { login: "reviewer" },
      comments: [{ id: 20, path: "src/a.ts", line: 7, body: "Inline note" }],
    },
  ]);
});

test("implementation requests use an authorized exact command comment", async () => {
  const github = client((args) => {
    const endpoint = args[1];
    if (endpoint.includes("/issues?state=open"))
      return JSON.stringify([
        { number: 7, title: "Add feature", body: "Requirements" },
      ]);
    if (endpoint.includes("/issues/7/comments"))
      return JSON.stringify([
        {
          id: 1,
          body: "@louibot implement please",
          user: { login: "owner" },
          created_at: "2026-10-16T00:00:00Z",
        },
        {
          id: 2,
          body: "@louibot implement",
          user: { login: "owner" },
          created_at: "2026-10-16T01:00:00Z",
        },
      ]);
    if (endpoint.includes("/collaborators/owner/permission"))
      return JSON.stringify({ permission: "write" });
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  });

  assert.deepEqual(await github.implementationRequests(), [
    {
      issue: { number: 7, title: "Add feature", body: "Requirements" },
      commentId: 2,
    },
  ]);
});

test("revision command combines authorized review and unresolved inline feedback", async () => {
  const github = client((args) => {
    const endpoint = args[1];
    if (endpoint.includes("/pulls/5/comments?")) return JSON.stringify([]);
    if (endpoint.includes("/issues/5/comments?"))
      return JSON.stringify([
        {
          id: 30,
          body: "@louibot revise",
          user: { login: "owner" },
          created_at: "2026-10-16T02:00:00Z",
        },
      ]);
    if (endpoint.includes("/reviews?"))
      return JSON.stringify([
        {
          id: 10,
          state: "COMMENTED",
          body: "Please add coverage",
          user: { login: "reviewer" },
        },
      ]);
    if (endpoint.includes("/collaborators/"))
      return JSON.stringify({ permission: "write" });
    if (endpoint === "repos/owner/repo")
      return JSON.stringify({ full_name: "owner/repo" });
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  });
  Object.defineProperty(github, "graphql", {
    value: async (_query: string, variables: Record<string, unknown>) =>
      variables.id
        ? {
            node: {
              comments: {
                nodes: [
                  {
                    databaseId: 20,
                    body: "Fix this line",
                    path: "src/a.ts",
                    line: 7,
                    author: { login: "reviewer" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }
        : {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ id: "thread-1", isResolved: false }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
  });

  assert.deepEqual(await github.revisionCommand(5, []), {
    eventId: "pr-command:30",
    commentEvents: ["review-comment:20"],
    feedback:
      "@reviewer review: Please add coverage\n\n@reviewer inline (src/a.ts:7): Fix this line",
  });
});

test("pull request details retain merge state", async () => {
  const github = client(() =>
    JSON.stringify({
      state: "closed",
      merged_at: "2026-10-16T01:00:00Z",
      number: 42,
      html_url: "https://github.com/owner/repo/pull/42",
    }),
  );

  assert.deepEqual(await github.pr(42), {
    state: "closed",
    mergedAt: "2026-10-16T01:00:00Z",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
  });
});

test("repository reads the repository through the REST API", async () => {
  const calls: string[][] = [];
  const github = client((args) => {
    calls.push(args);
    return JSON.stringify({ full_name: "owner/repo" });
  });

  assert.deepEqual(await github.repository(), { owner: "owner", name: "repo" });
  assert.deepEqual(calls[0], ["GET", "repos/owner/repo"]);
});

const phaseLabels = {
  issueLabel: "louibot:active",
  blockedLabel: "louibot:blocked",
  doneLabel: "louibot:done",
};

test("issue phase is idempotent and preserves unrelated labels", async () => {
  const calls: string[][] = [];
  const github = client((args) => {
    calls.push(args);
    if (args[1] === "repos/owner/repo/issues/5")
      return JSON.stringify({
        labels: [{ name: phaseLabels.issueLabel }, { name: "customer" }],
      });
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  });

  await github.setIssuePhase(5, "ready", phaseLabels);
  assert.equal(calls.length, 1);
});

test("issue phase transition adds the new managed label and removes only old managed labels", async () => {
  const calls: string[][] = [];
  const github = client((args) => {
    calls.push(args);
    if (args[1] === "repos/owner/repo/issues/5")
      return JSON.stringify({
        labels: [{ name: phaseLabels.issueLabel }, { name: "customer" }],
      });
    if (
      args[1] ===
      `repos/owner/repo/labels/${encodeURIComponent(phaseLabels.blockedLabel)}`
    )
      return JSON.stringify({ name: phaseLabels.blockedLabel });
    return "";
  });

  await github.setIssuePhase(5, "blocked", phaseLabels);
  assert.deepEqual(
    calls.slice(2).map((args) => args.slice(1)),
    [
      [
        `repos/owner/repo/issues/5/labels`,
        JSON.stringify({ labels: [phaseLabels.blockedLabel] }),
      ],
      [
        `repos/owner/repo/issues/5/labels/${encodeURIComponent(phaseLabels.issueLabel)}`,
      ],
    ],
  );
});

test("closed phase removes all attached managed labels without adding done", async () => {
  const calls: string[][] = [];
  const github = client((args) => {
    calls.push(args);
    if (args[1] === "repos/owner/repo/issues/5")
      return JSON.stringify({
        labels: [
          { name: phaseLabels.issueLabel },
          { name: phaseLabels.blockedLabel },
          { name: phaseLabels.doneLabel },
          { name: "customer" },
        ],
      });
    return "";
  });

  await github.setIssuePhase(5, "closed", phaseLabels);
  assert.deepEqual(
    calls.slice(1).map((args) => args[1]),
    [
      `repos/owner/repo/issues/5/labels/${encodeURIComponent(phaseLabels.issueLabel)}`,
      `repos/owner/repo/issues/5/labels/${encodeURIComponent(phaseLabels.blockedLabel)}`,
      `repos/owner/repo/issues/5/labels/${encodeURIComponent(phaseLabels.doneLabel)}`,
    ],
  );
  assert.equal(
    calls.some((args) => args.includes("POST")),
    false,
  );
});

test("issue phase treats a concurrently removed managed label as idempotent", async () => {
  const github = client((args) => {
    if (args[1] === "repos/owner/repo/issues/5")
      return JSON.stringify({ labels: [{ name: phaseLabels.issueLabel }] });
    if (
      args[1] ===
      `repos/owner/repo/labels/${encodeURIComponent(phaseLabels.blockedLabel)}`
    )
      return JSON.stringify({ name: phaseLabels.blockedLabel });
    if (args[1] === "repos/owner/repo/issues/5/labels") return "";
    if (args.includes("DELETE")) throw new Error("HTTP 404 Not Found");
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  });

  await github.setIssuePhase(5, "blocked", phaseLabels);
});

test("phase label is created after 404 and a racing 422 is verified", async () => {
  const calls: string[][] = [];
  const github = client((args) => {
    calls.push(args);
    if (args[1] === "repos/owner/repo/issues/5")
      return JSON.stringify({ labels: [] });
    if (
      args[1] ===
      `repos/owner/repo/labels/${encodeURIComponent(phaseLabels.issueLabel)}`
    ) {
      if (calls.filter((call) => call[1] === args[1]).length === 1)
        throw new Error("HTTP 404 Not Found");
      return JSON.stringify({ name: phaseLabels.issueLabel });
    }
    if (args[1] === "repos/owner/repo/labels")
      throw new Error("HTTP 422 already exists");
    return "";
  });

  await github.setIssuePhase(5, "ready", phaseLabels);
  assert.equal(
    calls.filter(
      (args) =>
        args[1] ===
        `repos/owner/repo/labels/${encodeURIComponent(phaseLabels.issueLabel)}`,
    ).length,
    2,
  );
  const create = calls.find((args) => args[1] === "repos/owner/repo/labels");
  assert.ok(create);
  assert.deepEqual(create, [
    "POST",
    "repos/owner/repo/labels",
    JSON.stringify({ name: phaseLabels.issueLabel, color: "0e8a16" }),
  ]);
});
