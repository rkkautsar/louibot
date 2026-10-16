import Database from "better-sqlite3";
import { appendFileSync, mkdirSync } from "node:fs";
export interface Job {
  issue: number;
  title: string;
  body: string;
  status: JobStatus;
  branch: string;
  worktree: string;
  revision: number;
  attempt?: number;
  pr?: number;
  model?: string;
  cost: number;
  codingSeconds?: number;
  codingStartedAt?: string;
  last: string;
  events: string[];
  feedback: string;
  rounds: number;
  retryRequested?: boolean;
  error?: string;
  outcome?: "merged" | "closed";
}

export type JobStatus =
  | "queued"
  | "coding"
  | "clarification"
  | "blocked"
  | "publishing"
  | "review"
  | "done"
  | "failed"
  | "stopped";
export class Store {
  private registeredSecrets = new Set<string>();
  db: Database.Database;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(`${dir}/jobs.sqlite`);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS jobs(issue INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS control(issue INTEGER PRIMARY KEY, stopped INTEGER NOT NULL)",
    );
  }
  all(): Job[] {
    return (
      this.db.prepare("SELECT data FROM jobs ORDER BY issue").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }
  get(issue: number): Job | undefined {
    const row = this.db
      .prepare("SELECT data FROM jobs WHERE issue = ?")
      .get(issue) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Job) : undefined;
  }
  save(job: Job) {
    this.db
      .prepare(
        "INSERT INTO jobs VALUES(?,?) ON CONFLICT(issue) DO UPDATE SET data=excluded.data",
      )
      .run(job.issue, JSON.stringify(job));
  }
  claim(job: Job) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO jobs VALUES(?,?)")
        .run(job.issue, JSON.stringify(job)).changes > 0
    );
  }
  stopped(issue: number): boolean {
    return !!(
      this.db
        .prepare("SELECT stopped FROM control WHERE issue=?")
        .get(issue) as { stopped: number } | undefined
    )?.stopped;
  }
  stop(issue: number): void {
    this.db.prepare("INSERT OR REPLACE INTO control VALUES(?,1)").run(issue);
  }
  registerSecret(value: string | undefined): void {
    if (value && value.length > 3) this.registeredSecrets.add(value);
  }
  retry(issue: number): Job {
    const job = this.get(issue);
    if (!job) throw new Error(`Unknown issue #${issue}`);
    if (
      job.status === "done" ||
      (!["failed", "blocked", "stopped"].includes(job.status) &&
        !this.stopped(issue))
    )
      throw new Error(`Issue #${issue} cannot be retried while ${job.status}`);
    this.db.prepare("INSERT OR REPLACE INTO control VALUES(?,0)").run(issue);
    job.status = "queued";
    job.retryRequested = true;
    job.last = new Date().toISOString();
    this.save(job);
    this.log(issue, "state", "queued");
    return job;
  }
  log(issue: number, event: string, data: unknown) {
    const secrets = [
      ...Object.entries(process.env)
        .filter(
          ([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && v && v.length > 3,
        )
        .map(([, v]) => v!),
      ...this.registeredSecrets,
    ];
    let line = JSON.stringify({ time: new Date().toISOString(), event, data });
    for (const secret of secrets) line = line.split(secret).join("[REDACTED]");
    line = line.replace(
      /(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/g,
      "[REDACTED]",
    );
    appendFileSync(`${this.dir}/${issue}.jsonl`, line + "\n", { mode: 0o600 });
  }
}
