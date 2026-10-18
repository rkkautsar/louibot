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
import { knownPricing, reviewerRates } from "./pricing.js";
import { GitHub } from "./github.js";
import { Store } from "./store.js";
import { git } from "./workspace.js";
import { formatDuration, tick } from "./workflow.js";
import { runDoctor } from "./doctor.js";
import { formatDiagnostic } from "./errors.js";
import { discoverValidationCommands } from "./discovery.js";
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
  review?: boolean;
  reviewerModel?: string;
  reviewerMaxSteps?: string;
  reviewerInputPrice?: string;
  reviewerOutputPrice?: string;
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
  requireValidation?: boolean;
  allowNoValidation?: boolean;
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
      "Host environment variable Louibot uses for the API key",
    )
    .option("--token-limit-parameter <name>", "Compatible API token parameter")
    .option("--reasoning-effort <effort>", "Compatible API reasoning effort")
    .option("--clear-endpoint", "Remove a saved OpenAI-compatible endpoint")
    .option("--input-price <usd>", "USD per million input tokens")
    .option("--output-price <usd>", "USD per million output tokens")
    .option("--review", "Enable the independent read-only review pass")
    .option("--no-review", "Disable the independent review pass")
    .option("--reviewer-model <provider/model>", "Model ID for the reviewer")
    .option(
      "--reviewer-max-steps <count>",
      "Maximum reviewer steps (default: 24)",
    )
    .option(
      "--reviewer-input-price <usd>",
      "Reviewer USD per million input tokens",
    )
    .option(
      "--reviewer-output-price <usd>",
      "Reviewer USD per million output tokens",
    )
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
    .option("--clear-validation-commands", "Use automatic validation discovery")
    .option(
      "--require-validation",
      "Fail if no controller validation commands are configured or discovered",
    )
    .option(
      "--allow-no-validation",
      "Allow jobs without controller validation (overrides saved requirement)",
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
  if (!!options.reviewerInputPrice !== !!options.reviewerOutputPrice)
    throw new Error(
      "Provide both --reviewer-input-price and --reviewer-output-price together",
    );
  if (options.clearValidationCommands && options.validationCommand?.length)
    throw new Error(
      "Use either --clear-validation-commands or --validation-command",
    );
  if (options.requireValidation && options.allowNoValidation)
    throw new Error("Use either --require-validation or --allow-no-validation");
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
  const savedReviewer = (saved.reviewer ?? {}) as Record<string, unknown>;
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
  const reviewerModel =
    options.reviewerModel ??
    (savedReviewer.model as string | undefined) ??
    model;
  const reviewerEnabled =
    options.review ?? (savedReviewer.enabled as boolean | undefined) ?? false;
  const reviewerHasSavedRates =
    savedReviewer.inputUsdPerMillion !== undefined &&
    savedReviewer.outputUsdPerMillion !== undefined;
  const reviewerSavedRatesMatch =
    reviewerHasSavedRates &&
    reviewerModel ===
      ((savedReviewer.model as string | undefined) ??
        (saved.model as string | undefined));
  const reviewerPricing = reviewerRates({
    model: reviewerModel,
    implementationModel: model,
    savedModel: saved.model as string | undefined,
    savedReviewerModel: savedReviewer.model as string | undefined,
    hasSavedRates: reviewerHasSavedRates,
    explicitRates:
      options.reviewerInputPrice && options.reviewerOutputPrice
        ? {
            inputUsdPerMillion: Number(options.reviewerInputPrice),
            outputUsdPerMillion: Number(options.reviewerOutputPrice),
          }
        : undefined,
    implementationRates: {
      inputUsdPerMillion: Number(
        agentOverrides.inputUsdPerMillion ?? savedAgent.inputUsdPerMillion,
      ),
      outputUsdPerMillion: Number(
        agentOverrides.outputUsdPerMillion ?? savedAgent.outputUsdPerMillion,
      ),
    },
  });
  if (
    reviewerEnabled &&
    reviewerModel !== model &&
    !reviewerPricing &&
    !reviewerSavedRatesMatch
  )
    throw new Error(
      `No built-in pricing is available for reviewer ${reviewerModel}; pass --reviewer-input-price and --reviewer-output-price`,
    );
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
    reviewer: defined({
      enabled: options.review,
      model: options.reviewerModel,
      maxSteps: numeric(options.reviewerMaxSteps),
      ...(reviewerPricing ?? {}),
      ...(options.reviewerInputPrice && options.reviewerOutputPrice
        ? {
            inputUsdPerMillion: Number(options.reviewerInputPrice),
            outputUsdPerMillion: Number(options.reviewerOutputPrice),
          }
        : {}),
    }),
    sandbox: defined({
      image: options.sandboxImage,
      commandTimeoutSeconds: numeric(options.commandTimeoutSeconds),
      network: options.sandboxNetwork,
    }),
    validation: {
      ...(options.clearValidationCommands
        ? { commands: [] }
        : options.validationCommand?.length
          ? { commands: options.validationCommand }
          : {}),
      ...defined({
        required: options.requireValidation
          ? true
          : options.allowNoValidation
            ? false
            : undefined,
      }),
    },
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
  let worker = "not running";
  try {
    const pid = Number(
      readFileSync(`${stateDirectory}/worker.lock`, "utf8").trim(),
    );
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      worker = "unknown (worker lock has an invalid PID)";
    } else {
      try {
        process.kill(pid, 0);
        worker = `running (PID ${pid})`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        worker =
          code === "ESRCH"
            ? `stale lock (PID ${pid} is not running)`
            : code === "EPERM"
              ? `running (PID ${pid}; permission check denied)`
              : `unknown (could not inspect PID ${pid})`;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      worker = "unknown (could not read worker lock)";
  }
  console.log(`Worker: ${worker}`);
  console.table(
    store.all().map((job) => ({
      issue: job.issue,
      state: store.stopped(job.issue) ? "stopped" : job.status,
      revision: job.revision,
      model: job.model ?? "unknown",
      reviewer: job.reviewerModel ? (job.reviewStatus ?? "pending") : "off",
      agentTime: formatDuration(job.codingSeconds),
      estimatedCostUsd: job.cost,
      last: job.last,
      errorCode: job.errorCode,
      error: job.error?.slice(0, 300),
      nextStep: job.remediation,
      detail: job.error ? undefined : job.feedback.slice(0, 120),
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
    `Queued #${issue} for retry with its existing workspace, history, and spending reservation. You can also post a new @louibot implement comment.`,
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
  const lockPath = `${stateDirectory}/worker.lock`;
  let lockDescriptor: number | undefined;
  let lockCreated = false;
  let store: Store | undefined;
  try {
    try {
      lockDescriptor = openSync(lockPath, "wx", 0o600);
      lockCreated = true;
      writeFileSync(lockDescriptor, String(process.pid));
      closeSync(lockDescriptor);
      lockDescriptor = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockContents = readFileSync(lockPath, "utf8").trim();
      const workerPid = Number(lockContents);
      if (!Number.isSafeInteger(workerPid) || workerPid <= 0)
        throw new Error(
          `Worker lock ${lockPath} does not contain a valid process ID; inspect it and remove it only if no Louibot worker is running.`,
        );
      try {
        process.kill(workerPid, 0);
      } catch (processError) {
        if ((processError as NodeJS.ErrnoException).code !== "ESRCH")
          throw processError;
        unlinkSync(lockPath);
        throw new Error(
          `Removed stale worker lock for PID ${workerPid}; start Louibot again.`,
        );
      }
      throw new Error(`Worker already running (PID ${workerPid})`);
    }
    store = new Store(stateDirectory);
    const shutdownController = new AbortController();
    const github = new GitHub(repositoryConfig.repository);
    process.once("SIGINT", () => shutdownController.abort());
    process.once("SIGTERM", () => shutdownController.abort());
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
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] Poll failed\n${formatDiagnostic(error)}`);
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
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    store?.db.close();
    if (lockCreated) {
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

addStartOptions(cli.command("start")).action(async (options: StartOptions) => {
  const repositoryConfig = await resolveConfig(options);
  const validationCommands = repositoryConfig.validation.commands.length
    ? repositoryConfig.validation.commands
    : await discoverValidationCommands(repositoryRoot);
  console.log(
    validationCommands.length
      ? `Controller validation: ${validationCommands.join(", ")}`
      : `Controller validation: none discovered${repositoryConfig.validation.required ? " (required; start stopped)" : " (allowed)"}`,
  );
  if (repositoryConfig.validation.required && !validationCommands.length)
    throw new Error(
      "Validation is required but no commands are configured or discovered. Set validation.commands or pass --validation-command.",
    );
  await runWorker(repositoryConfig);
});
cli.parseAsync().catch((error) => {
  console.error(formatDiagnostic(error));
  process.exitCode = 1;
});
