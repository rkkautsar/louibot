import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  user: { login: string };
  created_at?: string;
}

export interface ReviewRecord {
  id: number;
  state: string;
  body: string;
  user: { login: string };
  comments: ReviewCommentRecord[];
}

export interface ReviewCommentRecord {
  id: number;
  path: string;
  line?: number | null;
  body: string;
}

export interface PullRequestRecord {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
}

export interface PullRequestDetails {
  state: string;
  mergedAt: string | null;
  number: number;
  url: string;
}

export interface RepositoryRecord {
  owner: string;
  name: string;
}

export interface ImplementationRequest {
  issue: IssueRecord;
  commentId: number;
}

export interface RevisionRequest {
  eventId: string;
  feedback: string;
  consumedFeedbackEvents: string[];
}

type OpenReviewThreadComment = {
  databaseId: number;
  body: string;
  path: string | null;
  line: number | null;
  author: { login: string } | null;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type ApiComment = CommentRecord;
type IssuePhase = "ready" | "blocked" | "done" | "closed";
type PhaseLabels = {
  issueLabel: string;
  blockedLabel: string;
  doneLabel: string;
};

type ApiOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
};

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    endpoint: string,
  ) {
    super(`GitHub API request failed (HTTP ${status}): ${endpoint}`);
  }
}

export class GitHub {
  constructor(private readonly repo: string) {}

  private authenticatedLogin?: Promise<string>;

  private currentLogin(): Promise<string> {
    this.authenticatedLogin ??= this.api<{ login: string }>("user").then(
      (user) => user.login.toLowerCase(),
    );
    return this.authenticatedLogin;
  }

  private async api<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
    const args = ["api", endpoint];
    if (options.method && options.method !== "GET")
      args.push("--method", options.method);
    const input =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    if (input !== undefined) args.push("--input", "-");
    const output = await this.run(args, input);
    return output ? (JSON.parse(output) as T) : (undefined as T);
  }

  private async run(args: string[], input?: string): Promise<string> {
    const methodIndex = args.indexOf("--method");
    const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
    const retryable = method !== "POST";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce(args, input);
      } catch (error) {
        if (!retryable || attempt >= 2 || !this.isRetryable(error)) throw error;
        await delay(500 * 2 ** attempt);
      }
    }
  }

  private async runOnce(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "gh",
        args,
        {
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout.trim());
            return;
          }
          const text = `${stderr ?? ""} ${error.message ?? ""}`;
          const status = Number(text.match(/\bHTTP (\d{3})\b/)?.[1]);
          if (Number.isFinite(status)) {
            reject(new GitHubApiError(status, args[1] ?? ""));
            return;
          }
          reject(error);
        },
      );
      child.stdin?.end(input);
    });
  }

  private isRetryable(error: unknown): boolean {
    const status = error instanceof GitHubApiError ? error.status : undefined;
    if (status === 429 || (status !== undefined && status >= 500)) return true;
    const code = (error as NodeJS.ErrnoException)?.code;
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(
      code ?? "",
    );
  }

  private async paginated<T>(endpoint: string): Promise<T[]> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const pageParameter = endpoint.includes("per_page=")
      ? `page=`
      : `per_page=100&page=`;
    const results: T[] = [];
    for (let page = 1; ; page++) {
      const pageResults = await this.api<T[]>(
        `${endpoint}${separator}${pageParameter}${page}`,
      );
      results.push(...pageResults);
      if (pageResults.length < 100) return results;
    }
  }

  async issues(label: string): Promise<IssueRecord[]> {
    const encoded = encodeURIComponent(label);
    const issues = await this.paginated<
      IssueRecord & { pull_request?: unknown }
    >(`repos/${this.repo}/issues?state=open&labels=${encoded}&per_page=100`);
    return issues.filter((item) => !("pull_request" in item));
  }

  async implementationRequests(): Promise<ImplementationRequest[]> {
    const requests: ImplementationRequest[] = [];
    for (const issue of await this.openIssues()) {
      const comments = await this.comments(issue.number);
      const candidates = comments
        .filter((comment) => this.isImplementCommand(comment.body))
        .sort(
          (left, right) =>
            Date.parse(right.created_at ?? "") -
              Date.parse(left.created_at ?? "") || right.id - left.id,
        );
      for (const trigger of candidates) {
        if (trigger.user.login.toLowerCase() !== (await this.currentLogin()))
          continue;
        if (!(await this.authorized(trigger.user.login))) continue;
        requests.push({ issue, commentId: trigger.id });
        break;
      }
    }
    return requests;
  }

  private async openIssues(): Promise<IssueRecord[]> {
    const issues = await this.paginated<
      IssueRecord & { pull_request?: unknown; body: string | null }
    >(`repos/${this.repo}/issues?state=open&per_page=100`);
    return issues
      .filter((item) => !("pull_request" in item))
      .map((item) => ({ ...item, body: item.body ?? "" }));
  }

  private isImplementCommand(body: string): boolean {
    return body.trim().toLowerCase() === "@louibot implement";
  }

  private isReviseCommand(body: string): boolean {
    return body.trim().toLowerCase() === "@louibot revise";
  }

  async revisionCommand(
    pr: number,
    processed: string[],
  ): Promise<RevisionRequest | undefined> {
    const comments = await this.comments(pr);
    const candidates = comments
      .filter(
        (comment) =>
          this.isReviseCommand(comment.body) &&
          !processed.includes(`pr-command:${comment.id}`),
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at ?? "") -
            Date.parse(left.created_at ?? "") || right.id - left.id,
      );
    let trigger: CommentRecord | undefined;
    for (const candidate of candidates) {
      if (candidate.user.login.toLowerCase() !== (await this.currentLogin()))
        continue;
      if (await this.authorized(candidate.user.login)) {
        trigger = candidate;
        break;
      }
    }
    if (!trigger) return undefined;

    const [reviews, threads, discussion] = await Promise.all([
      this.reviews(pr),
      this.openReviewThreads(pr),
      this.comments(pr),
    ]);
    const acceptedDiscussion: CommentRecord[] = [];
    for (const comment of discussion) {
      if (
        this.isReviseCommand(comment.body) ||
        /<!--\s*louibot:/i.test(comment.body)
      )
        continue;
      if (await this.authorized(comment.user.login))
        acceptedDiscussion.push(comment);
    }
    const acceptedReviews: ReviewRecord[] = [];
    for (const review of reviews) {
      if (
        review.body.trim() &&
        !processed.includes(`review:${review.id}`) &&
        (await this.authorized(review.user.login))
      )
        acceptedReviews.push(review);
    }
    const acceptedThreads: OpenReviewThreadComment[] = [];
    for (const comment of threads) {
      if (
        comment.author?.login &&
        (await this.authorized(comment.author.login))
      )
        acceptedThreads.push(comment);
    }
    const text = [
      ...acceptedDiscussion.map(
        (comment) =>
          `@${comment.user.login} PR discussion: ${comment.body.trim()}`,
      ),
      ...acceptedReviews.map(
        (review) => `@${review.user.login} review: ${review.body.trim()}`,
      ),
      ...acceptedThreads.map((comment) => {
        const location = comment.path
          ? ` (${comment.path}${comment.line ? `:${comment.line}` : ""})`
          : "";
        return `@${comment.author!.login} inline${location}: ${comment.body.trim()}`;
      }),
    ].join("\n\n");
    return {
      eventId: `pr-command:${trigger.id}`,
      consumedFeedbackEvents: [
        ...acceptedReviews.map((review) => `review:${review.id}`),
        ...acceptedDiscussion.map((comment) => `pr-comment:${comment.id}`),
        ...acceptedThreads.map(
          (comment) => `review-comment:${comment.databaseId}`,
        ),
      ],
      feedback:
        text ||
        "The revise command was received, but no new authorized review feedback or unresolved inline comments were found. Do not invent changes.",
    };
  }

  private async openReviewThreads(
    pr: number,
  ): Promise<OpenReviewThreadComment[]> {
    const { owner, name } = await this.repository();
    const comments: OpenReviewThreadComment[] = [];
    let after: string | undefined;
    do {
      const result = await this.graphql<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{ id: string; isResolved: boolean }>;
              pageInfo: PageInfo;
            };
          };
        };
      }>(
        `query($owner:String!,$name:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) { nodes { id isResolved } pageInfo { hasNextPage endCursor } } } } }`,
        { owner, name, number: pr, after },
      );
      for (const thread of result.repository.pullRequest.reviewThreads.nodes) {
        if (!thread.isResolved)
          comments.push(...(await this.reviewThreadComments(thread.id)));
      }
      const pageInfo = result.repository.pullRequest.reviewThreads.pageInfo;
      after = pageInfo.hasNextPage
        ? (pageInfo.endCursor ?? undefined)
        : undefined;
    } while (after);
    return comments;
  }

  private async reviewThreadComments(
    threadId: string,
  ): Promise<OpenReviewThreadComment[]> {
    const comments: OpenReviewThreadComment[] = [];
    let after: string | undefined;
    do {
      const result = await this.graphql<{
        node: {
          comments: {
            nodes: OpenReviewThreadComment[];
            pageInfo: PageInfo;
          };
        } | null;
      }>(
        `query($id:ID!,$after:String) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$after) { nodes { databaseId body path line author { login } } pageInfo { hasNextPage endCursor } } } } }`,
        { id: threadId, after },
      );
      if (!result.node) return comments;
      comments.push(...result.node.comments.nodes);
      const pageInfo = result.node.comments.pageInfo;
      after = pageInfo.hasNextPage
        ? (pageInfo.endCursor ?? undefined)
        : undefined;
    } while (after);
    return comments;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, string | number | undefined>,
  ): Promise<T> {
    const args = ["api", "graphql", "--field", `query=${query}`];
    for (const [key, value] of Object.entries(variables))
      if (value !== undefined) args.push("--field", `${key}=${value}`);
    const output = await this.run(args);
    const result = JSON.parse(output) as { data?: T; errors?: unknown[] };
    if (result.errors?.length) throw new Error("GitHub GraphQL request failed");
    if (!result.data) throw new Error("GitHub GraphQL response had no data");
    return result.data;
  }

  async comments(issue: number): Promise<CommentRecord[]> {
    return this.paginated<CommentRecord>(
      `repos/${this.repo}/issues/${issue}/comments?per_page=100`,
    );
  }

  async setIssuePhase(
    issue: number,
    phase: IssuePhase,
    labels: PhaseLabels,
  ): Promise<void> {
    const managed = [
      ...new Set([labels.issueLabel, labels.blockedLabel, labels.doneLabel]),
    ];
    const desired =
      phase === "ready"
        ? labels.issueLabel
        : phase === "blocked"
          ? labels.blockedLabel
          : phase === "done"
            ? labels.doneLabel
            : undefined;
    const current = await this.api<{ labels: { name: string }[] }>(
      `repos/${this.repo}/issues/${issue}`,
    );
    const attached = new Set(current.labels.map((label) => label.name));

    if (desired && !attached.has(desired)) {
      await this.ensureIssueLabel(desired, phase);
      await this.api(`repos/${this.repo}/issues/${issue}/labels`, {
        method: "POST",
        body: { labels: [desired] },
      });
    }

    for (const label of managed) {
      if (label !== desired && attached.has(label)) {
        try {
          await this.api(
            `repos/${this.repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
            { method: "DELETE" },
          );
        } catch (error) {
          if (!this.isNotFound(error)) throw error;
        }
      }
    }
  }

  private async ensureIssueLabel(
    label: string,
    phase: IssuePhase,
  ): Promise<void> {
    const endpoint = `repos/${this.repo}/labels/${encodeURIComponent(label)}`;
    try {
      await this.api(endpoint);
      return;
    } catch (error) {
      if (!this.isNotFound(error)) throw error;
    }

    const color =
      phase === "ready" ? "0e8a16" : phase === "blocked" ? "fbca04" : "1d76db";
    try {
      await this.api(`repos/${this.repo}/labels`, {
        method: "POST",
        body: { name: label, color },
      });
    } catch (error) {
      if (!this.hasStatus(error, 422)) throw error;
      await this.api(endpoint);
    }
  }

  private hasStatus(error: unknown, status: number): boolean {
    const detail = error as { status?: number; message?: string };
    return (
      (error instanceof GitHubApiError && error.status === status) ||
      detail?.status === status ||
      new RegExp(`\\bHTTP ${status}\\b`).test(detail?.message ?? "")
    );
  }

  private isNotFound(error: unknown): boolean {
    return this.hasStatus(error, 404);
  }

  async authorized(login: string): Promise<boolean> {
    try {
      const result = await this.api<{ permission: string }>(
        `repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      return ["write", "maintain", "admin"].includes(result.permission);
    } catch (error) {
      if (
        this.hasStatus(error, 401) ||
        this.hasStatus(error, 403) ||
        this.hasStatus(error, 404)
      )
        return false;
      throw error;
    }
  }

  async comment(issue: number, body: string, marker: string): Promise<number> {
    const existing = await this.paginated<ApiComment>(
      `repos/${this.repo}/issues/${issue}/comments?per_page=100`,
    );
    const found = existing.find((item) => item.body.includes(marker));
    if (found) return found.id;

    const content = `${body}\n\n<!-- ${marker} -->`;
    const created = await this.api<ApiComment>(
      `repos/${this.repo}/issues/${issue}/comments`,
      { method: "POST", body: { body: content } },
    );
    return created.id;
  }

  async findPR(branch: string): Promise<PullRequestRecord | undefined> {
    const [owner] = this.repo.split("/");
    const pulls = await this.api<
      Array<{
        number: number;
        title: string;
        html_url: string;
        state: string;
        draft: boolean;
      }>
    >(
      `repos/${this.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
    );
    const pull = pulls[0];
    return pull
      ? {
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          state: pull.state,
          isDraft: pull.draft,
        }
      : undefined;
  }

  async createPR(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullRequestRecord> {
    const repository = await this.api<{ default_branch: string }>(
      `repos/${this.repo}`,
    );
    const created = await this.api<{
      number: number;
      title: string;
      html_url: string;
      state: string;
      draft: boolean;
    }>(`repos/${this.repo}/pulls`, {
      method: "POST",
      body: {
        title,
        body,
        head: branch,
        base: repository.default_branch,
        draft: true,
      },
    });
    return {
      number: created.number,
      title: created.title,
      url: created.html_url,
      state: created.state,
      isDraft: created.draft,
    };
  }

  async reviews(pr: number): Promise<ReviewRecord[]> {
    const [reviews, comments] = await Promise.all([
      this.paginated<Omit<ReviewRecord, "comments">>(
        `repos/${this.repo}/pulls/${pr}/reviews?per_page=100`,
      ),
      this.paginated<ReviewCommentRecord & { pull_request_review_id: number }>(
        `repos/${this.repo}/pulls/${pr}/comments?per_page=100`,
      ),
    ]);
    return reviews.map((review) => ({
      ...review,
      comments: comments
        .filter((comment) => comment.pull_request_review_id === review.id)
        .map(({ id, path, line, body }) => ({
          id,
          path,
          line: line ?? null,
          body,
        })),
    }));
  }

  async pr(number: number): Promise<PullRequestDetails> {
    const result = await this.api<{
      state: string;
      merged_at: string | null;
      number: number;
      html_url: string;
    }>(`repos/${this.repo}/pulls/${number}`);
    return {
      state: result.state,
      mergedAt: result.merged_at,
      number: result.number,
      url: result.html_url,
    };
  }

  async repository(): Promise<RepositoryRecord> {
    const result = await this.api<{ full_name: string }>(`repos/${this.repo}`);
    const [owner, name] = result.full_name.split("/");
    if (!owner || !name)
      throw new Error("GitHub returned an invalid repository name");
    return { owner, name };
  }
}
