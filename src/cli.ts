#!/usr/bin/env node
import { Command } from "commander";
import {
  readFileSync,
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config, savedConfig } from "./config.js";
import { knownPricing } from "./pricing.js";
import { GitHub } from "./github.js";
import { Store } from "./store.js";
import { git } from "./workspace.js";
import { formatDuration, tick } from "./workflow.js";
import { runDoctor } from "./doctor.js";
const cli = new Command()
  .name("louibot")
  .description("Assign an issue. Get a draft PR.");
const repositoryRoot = process.cwd(),
  stateDirectory = resolve(repositoryRoot, ".louibot");
interface StartOptions {
  repository?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  tokenLimitParameter?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  inputPrice?: string;
  outputPrice?: string;
  issueLabel?: string;
  blockedLabel?: string;
  doneLabel?: string;
  pollIntervalSeconds?: string;
  maxConcurrentJobs?: string;
  maxSteps?: string;
  maxCostUsd?: string;
  contextWindowTokens?: string;
  maxInputTokens?: string;
  maxOutputTokens?: string;
  sandboxImage?: string;
  commandTimeoutSeconds?: string;
  sandboxNetwork?: "bridge" | "none";
  validationCommand?: string[];
  clearValidationCommands?: boolean;
  clearEndpoint?: boolean;
}

function addStartOptions(command: Command) {
  return command
    .option(
      "--repository <owner/repo>",
      "GitHub repository (defaults to origin)",
    )
    .option("--model <provider/model>", "Model ID, e.g. openai/gpt-6-luna")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option(
      "--api-key-env <name>",
      "Host environment variable containing the API key",
    )
    .option("--token-limit-parameter <name>", "Compatible API token parameter")
    .option("--reasoning-effort <effort>", "Compatible API reasoning effort")
    .option("--clear-endpoint", "Remove a saved OpenAI-compatible endpoint")
    .option("--input-price <usd>", "USD per million input tokens")
    .option("--output-price <usd>", "USD per million output tokens")
    .option("--issue-label <label>", "Issue label that opts in to Louibot")
    .option("--blocked-label <label>", "Status label for blocked jobs")
    .option("--done-label <label>", "Status label for completed jobs")
    .option(
      "--poll-interval-seconds <seconds>",
      "GitHub polling interval (minimum 5)",
    )
    .option("--max-concurrent-jobs <count>", "Maximum active jobs (1-8)")
    .option("--max-steps <count>", "Maximum agent steps per run")
    .option("--max-cost-usd <usd>", "Maximum estimated spend per issue")
    .option("--context-window-tokens <count>", "Model context window size")
    .option("--max-input-tokens <count>", "Maximum input tokens per model call")
    .option(
      "--max-output-tokens <count>",
      "Maximum output tokens per model call",
    )
    .option("--sandbox-image <image>", "Docker image, or auto-discover")
    .option("--command-timeout-seconds <seconds>", "Shell command timeout")
    .option("--sandbox-network <mode>", "Sandbox network: bridge or none")
    .option(
      "--validation-command <command>",
      "Validation command; repeat to set multiple",
      (command: string, commands: string[] = []) => [...commands, command],
      [],
    )
    .option(
      "--clear-validation-commands",
      "Use automatic validation discovery",
    );
}

function numeric(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
}
function defined(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

async function resolveConfig(options: StartOptions) {
  if (!!options.inputPrice !== !!options.outputPrice)
    throw new Error("Provide both --input-price and --output-price together");
  if (options.clearValidationCommands && options.validationCommand?.length)
    throw new Error(
      "Use either --clear-validation-commands or --validation-command",
    );
  if (
    options.clearEndpoint &&
    (options.baseUrl ||
      options.apiKeyEnv ||
      options.tokenLimitParameter ||
      options.reasoningEffort)
  )
    throw new Error(
      "Use either --clear-endpoint or compatible endpoint options",
    );
  const saved = savedConfig(repositoryRoot);
  const repository =
    options.repository ??
    (saved.repository as string | undefined) ??
    (await git(repositoryRoot, ["remote", "get-url", "origin"])).match(
      /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
    )?.[1];
  if (!repository)
    throw new Error(
      "Could not determine GitHub repository; pass --repository owner/repo",
    );

  const savedAgent = (saved.agent ?? {}) as Record<string, unknown>;
  const model = options.model ?? (saved.model as string | undefined);
  if (!model)
    throw new Error(
      "Pass --model provider/model or add model to .louibot/config.yaml",
    );
  const savedHasPricing =
    saved.model === model &&
    savedAgent.inputUsdPerMillion !== undefined &&
    savedAgent.outputUsdPerMillion !== undefined;
  const pricing =
    options.inputPrice && options.outputPrice
      ? {
          inputUsdPerMillion: Number(options.inputPrice),
          outputUsdPerMillion: Number(options.outputPrice),
        }
      : savedHasPricing
        ? undefined
        : knownPricing(model);
  const agentOverrides: Record<string, unknown> = {
    maxConcurrentJobs: numeric(options.maxConcurrentJobs),
    maxSteps: numeric(options.maxSteps),
    maxCostUsd: numeric(options.maxCostUsd),
    contextWindowTokens: numeric(options.contextWindowTokens),
    maxInputTokens: numeric(options.maxInputTokens),
    maxOutputTokens: numeric(options.maxOutputTokens),
    ...(pricing ?? {}),
  };
  if (options.inputPrice && options.outputPrice) {
    agentOverrides.inputUsdPerMillion = Number(options.inputPrice);
    agentOverrides.outputUsdPerMillion = Number(options.outputPrice);
  } else if (savedHasPricing) {
    // Keep saved provider pricing unless overridden on the command line.
  } else if (!pricing) {
    throw new Error(
      `No built-in pricing is available for ${model}; pass --input-price and --output-price`,
    );
  }
  const endpointOptions = defined({
    baseUrl: options.baseUrl,
    apiKeyEnv:
      options.apiKeyEnv ??
      (options.baseUrl &&
      !(saved.endpoint as Record<string, unknown> | undefined)?.apiKeyEnv
        ? "OPENAI_API_KEY"
        : undefined),
    tokenLimitParameter: options.tokenLimitParameter,
    reasoningEffort: options.reasoningEffort,
  });
  const overrides = {
    repository,
    model,
    endpoint: options.clearEndpoint
      ? null
      : Object.keys(endpointOptions).length
        ? endpointOptions
        : undefined,
    github: defined({
      issueLabel: options.issueLabel,
      blockedLabel: options.blockedLabel,
      doneLabel: options.doneLabel,
      pollIntervalSeconds: numeric(options.pollIntervalSeconds),
    }),
    agent: defined(agentOverrides),
    sandbox: defined({
      image: options.sandboxImage,
      commandTimeoutSeconds: numeric(options.commandTimeoutSeconds),
      network: options.sandboxNetwork,
    }),
    validation: options.clearValidationCommands
      ? { commands: [] }
      : options.validationCommand?.length
        ? { commands: options.validationCommand }
        : {},
  };
  return config(repositoryRoot, overrides);
}

addStartOptions(cli.command("doctor")).action(async (options: StartOptions) => {
  const healthy = await runDoctor(
    repositoryRoot,
    stateDirectory,
    await resolveConfig(options),
  );
  if (!healthy) process.exitCode = 1;
});
cli.command("status").action(() => {
  const store = new Store(stateDirectory);
  console.table(
    store.all().map((job) => ({
      issue: job.issue,
      state: store.stopped(job.issue) ? "stopped" : job.status,
      revision: job.revision,
      model: job.model ?? "unknown",
      agentTime: formatDuration(job.codingSeconds),
      estimatedCostUsd: job.cost,
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
async function runWorker(repositoryConfig: ReturnType<typeof config>) {
  const store = new Store(stateDirectory),
    lockPath = `${stateDirectory}/worker.lock`;
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
      throw new Error("Removed stale worker lock; run start again");
    }
    throw new Error(`Worker already running (PID ${workerPid})`);
  }
  const shutdownController = new AbortController();
  const github = new GitHub(repositoryConfig.repository);
  process.once("SIGINT", () => shutdownController.abort());
  process.once("SIGTERM", () => shutdownController.abort());
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
    store.db.close();
    unlinkSync(lockPath);
  }
}

addStartOptions(cli.command("start")).action(async (options: StartOptions) => {
  await runWorker(await resolveConfig(options));
});
cli.parseAsync().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
