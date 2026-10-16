#!/usr/bin/env node
import { Command } from "commander";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stringify } from "yaml";
import { config, schema } from "./config.js";
import { GitHub } from "./github.js";
import { Store } from "./store.js";
import { git } from "./workspace.js";
import { tick } from "./workflow.js";
const cli = new Command()
  .name("louibot")
  .description("Assign an issue. Get a draft PR.");
const repositoryRoot = process.cwd(),
  stateDirectory = resolve(repositoryRoot, ".louibot");
cli
  .command("init")
  .requiredOption("--model <provider/model>")
  .option("--base-url <url>", "OpenAI-compatible API base URL")
  .option(
    "--api-key-env <name>",
    "Host environment variable containing the compatible API key",
  )
  .requiredOption("--input-price <usd>", "USD per million input tokens")
  .requiredOption("--output-price <usd>", "USD per million output tokens")
  .action(initializeRepository);

interface InitOptions {
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  inputPrice: string;
  outputPrice: string;
}

async function initializeRepository(options: InitOptions) {
  if (existsSync(`${stateDirectory}/config.yaml`))
    throw new Error("Configuration already exists");
  const remote = await git(repositoryRoot, ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("origin must be a GitHub repository");
  const repositoryConfig = schema.parse({
    repository: match[1],
    model: options.model,
    endpoint:
      options.baseUrl || options.apiKeyEnv
        ? { baseUrl: options.baseUrl, apiKeyEnv: options.apiKeyEnv }
        : undefined,
    agent: {
      inputUsdPerMillion: Number(options.inputPrice),
      outputUsdPerMillion: Number(options.outputPrice),
    },
  });
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(`${stateDirectory}/config.yaml`, stringify(repositoryConfig), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Configured .louibot/config.yaml. Authenticate with gh auth login. Set ${repositoryConfig.endpoint?.apiKeyEnv ?? (repositoryConfig.model.startsWith("anthropic/") ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")} in the host environment. Pre-pull the configured Docker image.`,
  );
}

cli.command("status").action(() => {
  const store = new Store(stateDirectory);
  console.table(
    store.all().map((job) => ({
      issue: job.issue,
      state: store.stopped(job.issue) ? "stopped" : job.status,
      revision: job.revision,
      costReservedUsd: job.cost,
      last: job.last,
      detail: (job.error ?? job.feedback).slice(0, 120),
    })),
  );
  store.db.close();
});
cli.command("stop <issue>").action((issue) => {
  const store = new Store(stateDirectory);
  store.stop(Number(issue));
  store.db.close();
  console.log(
    `Cancellation requested for #${issue}; persisted work is retained.`,
  );
});
cli.command("retry <issue>").action((issue) => {
  if (!/^\d+$/.test(issue)) throw new Error("Issue must be numeric");
  const store = new Store(stateDirectory);
  try {
    store.retry(Number(issue));
  } finally {
    store.db.close();
  }
  console.log(
    `Queued #${issue} for retry with its existing workspace, history, and spending reservation.`,
  );
});
cli
  .command("logs <issue>")
  .option("--follow")
  .action(async (issue, options) => {
    if (!/^\d+$/.test(issue)) throw new Error("Issue must be numeric");
    let offset = 0;
    do {
      try {
        const data = readFileSync(`${stateDirectory}/${issue}.jsonl`, "utf8");
        process.stdout.write(data.slice(offset));
        offset = data.length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (options.follow) await sleep(1000);
    } while (options.follow);
  });
async function startWorker() {
  const repositoryConfig = config(repositoryRoot),
    store = new Store(stateDirectory),
    lockPath = `${stateDirectory}/worker.lockPath`;
  try {
    const lockDescriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(lockDescriptor, String(process.pid));
    closeSync(lockDescriptor);
  } catch {
    const workerPid = Number(readFileSync(lockPath, "utf8"));
    try {
      process.kill(workerPid, 0);
    } catch {
      unlinkSync(lockPath);
      throw new Error("Removed stale worker lockPath; run start again");
    }
    throw new Error(`Worker already running (PID ${workerPid})`);
  }
  const shutdownController = new AbortController();
  const github = new GitHub(repositoryConfig.repository);
  process.once("SIGINT", () => shutdownController.abort());
  process.once("SIGTERM", () => shutdownController.abort());
  const cancellationMonitor = setInterval(() => {
    if (
      store
        .all()
        .some((job) => job.status === "coding" && store.stopped(job.issue))
    )
      shutdownController.abort();
  }, 500);
  try {
    console.log(`Watching ${repositoryConfig.repository}`);
    while (!shutdownController.signal.aborted) {
      try {
        await tick(
          repositoryRoot,
          repositoryConfig,
          store,
          shutdownController.signal,
          github,
        );
      } catch (error) {
        console.error(String(error));
      }
      await sleep(
        repositoryConfig.github.pollIntervalSeconds * 1000,
        undefined,
        {
          signal: shutdownController.signal,
        },
      ).catch(() => {});
    }
  } finally {
    clearInterval(cancellationMonitor);
    store.db.close();
    unlinkSync(lockPath);
  }
}

cli.command("start").action(startWorker);
cli.parseAsync().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
