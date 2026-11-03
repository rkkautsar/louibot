import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export const schema = z
  .object({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    model: z.string().regex(/^(openai|anthropic|openai-compatible)\/.+/),
    endpoint: z
      .object({
        apiFormat: z
          .enum(["chat-completions", "responses"])
          .default("responses"),
        baseUrl: z.url().refine((value) => {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")
          );
        }, "Use an HTTP(S) API base URL without credentials, query, or fragment; omit /chat/completions because Louibot appends it"),
        apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        tokenLimitParameter: z
          .enum(["max_tokens", "max_completion_tokens"])
          .optional(),
        reasoningEffort: reasoningEffortSchema.optional(),
      })
      .optional(),
    github: z
      .object({
        issueLabel: z.string().default("louibot:active"),
        blockedLabel: z.string().default("louibot:blocked"),
        doneLabel: z.string().default("louibot:done"),
        pollIntervalSeconds: z.number().min(5).default(30),
      })
      .default({
        issueLabel: "louibot:active",
        blockedLabel: "louibot:blocked",
        doneLabel: "louibot:done",
        pollIntervalSeconds: 30,
      }),
    agent: z.object({
      maxConcurrentJobs: z.number().int().min(1).max(8).default(1),
      maxSteps: z.number().int().positive().default(60),
      maxCostUsd: z.number().positive().default(3),
      contextWindowTokens: z.number().int().positive().default(200000),
      maxInputTokens: z.number().int().positive().default(160000),
      maxOutputTokens: z.number().int().positive().default(32000),
      clarificationEnabled: z.boolean().default(true),
      modelMaxRetries: z.number().int().min(0).max(5).default(2),
      modelRequestTimeoutSeconds: z.number().int().positive().default(180),
      inputUsdPerMillion: z.number().nonnegative(),
      outputUsdPerMillion: z.number().nonnegative(),
    }),
    reviewer: z
      .object({
        enabled: z.boolean().default(false),
        pairedWorkflow: z
          .object({
            enabled: z.boolean().default(false),
            investigatorReasoningEffort: reasoningEffortSchema.optional(),
            implementerReasoningEffort: reasoningEffortSchema.optional(),
            plannerModel: z
              .string()
              .regex(/^(openai|anthropic|openai-compatible)\/.+/)
              .optional(),
            plannerApiFormat: z
              .enum(["chat-completions", "responses"])
              .optional(),
            plannerInputUsdPerMillion: z.number().nonnegative().optional(),
            plannerOutputUsdPerMillion: z.number().nonnegative().optional(),
            parallelInvestigations: z.number().int().min(1).max(6).default(6),
            maxInvestigationRounds: z.number().int().min(1).max(8).default(8),
            maxImplementationReviews: z
              .number()
              .int()
              .min(1)
              .max(10)
              .default(5),
            evidenceJudge: z
              .object({
                accountIdEnv: z
                  .string()
                  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
                  .default("CLOUDFLARE_ACCOUNT_ID"),
                apiTokenEnv: z
                  .string()
                  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
                  .default("CLOUDFLARE_API_TOKEN"),
                inputUsdPerMillion: z.number().nonnegative().default(0.038),
              })
              .default({
                accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
                apiTokenEnv: "CLOUDFLARE_API_TOKEN",
                inputUsdPerMillion: 0.038,
              }),
          })
          .default({
            enabled: false,
            parallelInvestigations: 6,
            maxInvestigationRounds: 8,
            maxImplementationReviews: 5,
            evidenceJudge: {
              accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
              apiTokenEnv: "CLOUDFLARE_API_TOKEN",
              inputUsdPerMillion: 0.038,
            },
          }),
        model: z
          .string()
          .regex(/^(openai|anthropic|openai-compatible)\/.+/)
          .optional(),
        maxSteps: z.number().int().positive().default(24),
        inputUsdPerMillion: z.number().nonnegative().optional(),
        outputUsdPerMillion: z.number().nonnegative().optional(),
      })
      .default({
        enabled: false,
        pairedWorkflow: {
          enabled: false,
          parallelInvestigations: 6,
          maxInvestigationRounds: 8,
          maxImplementationReviews: 5,
          evidenceJudge: {
            accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
            apiTokenEnv: "CLOUDFLARE_API_TOKEN",
            inputUsdPerMillion: 0.038,
          },
        },
        maxSteps: 24,
      }),
    sandbox: z
      .object({
        image: z.string().default("auto"),
        commandTimeoutSeconds: z.number().positive().default(120),
        network: z.enum(["bridge", "none"]).default("bridge"),
        setupCommands: z.array(z.string().min(1).max(2000)).max(10).optional(),
      })
      .default({
        image: "auto",
        commandTimeoutSeconds: 120,
        network: "bridge",
      }),
    validation: z
      .object({
        commands: z.array(z.string().min(1).max(2000)).max(20).default([]),
        required: z.boolean().default(false),
      })
      .default({ commands: [], required: false }),
  })
  .superRefine((config, context) => {
    if (config.model.startsWith("openai-compatible/") && !config.endpoint)
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message:
          "OpenAI-compatible models require endpoint.baseUrl and endpoint.apiKeyEnv",
      });
    if (!config.model.startsWith("openai-compatible/") && config.endpoint)
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "Custom endpoints require the openai-compatible provider",
      });
    const reviewerModel = config.reviewer.model ?? config.model;
    if (
      config.reviewer.pairedWorkflow.plannerModel?.startsWith(
        "openai-compatible/",
      ) &&
      !config.endpoint
    )
      context.addIssue({
        code: "custom",
        path: ["reviewer", "pairedWorkflow", "plannerModel"],
        message:
          "The planner model uses openai-compatible and requires endpoint configuration",
      });
    const plannerModel =
      config.reviewer.pairedWorkflow.plannerModel ?? config.model;
    if (
      config.reviewer.pairedWorkflow.plannerApiFormat &&
      !plannerModel.startsWith("openai-compatible/")
    )
      context.addIssue({
        code: "custom",
        path: ["reviewer", "pairedWorkflow", "plannerApiFormat"],
        message:
          "plannerApiFormat only applies to openai-compatible planner models",
      });
    if (
      (config.reviewer.pairedWorkflow.investigatorReasoningEffort ||
        config.reviewer.pairedWorkflow.implementerReasoningEffort) &&
      !config.model.startsWith("openai-compatible/")
    )
      context.addIssue({
        code: "custom",
        path: ["reviewer", "pairedWorkflow", "investigatorReasoningEffort"],
        message:
          "Reasoning effort overrides require an openai-compatible model",
      });
    const reviewerHasInputPrice =
      config.reviewer.inputUsdPerMillion !== undefined;
    const reviewerHasOutputPrice =
      config.reviewer.outputUsdPerMillion !== undefined;
    if (reviewerHasInputPrice !== reviewerHasOutputPrice)
      context.addIssue({
        code: "custom",
        path: ["reviewer"],
        message: "Reviewer input and output prices must be set together",
      });
    if (
      config.reviewer.enabled &&
      reviewerModel.split("/")[0] !== config.model.split("/")[0]
    )
      context.addIssue({
        code: "custom",
        path: ["reviewer", "model"],
        message:
          "The reviewer must use the implementation model's provider and endpoint",
      });
    if (
      config.reviewer.enabled &&
      reviewerModel !== config.model &&
      (!reviewerHasInputPrice || !reviewerHasOutputPrice)
    )
      context.addIssue({
        code: "custom",
        path: ["reviewer"],
        message:
          "Set reviewer inputUsdPerMillion and outputUsdPerMillion when using a different reviewer model",
      });
    if (config.reviewer.pairedWorkflow.enabled && !config.reviewer.enabled)
      context.addIssue({
        code: "custom",
        path: ["reviewer", "pairedWorkflow", "enabled"],
        message: "Paired workflow requires reviewer.enabled",
      });
  });
export type Config = z.infer<typeof schema>;
export function savedConfig(projectRoot: string): Record<string, unknown> {
  const path = `${projectRoot}/.louibot/config.yaml`;
  if (!existsSync(path)) return {};
  const saved = parse(readFileSync(path, "utf8"));
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw new Error("Configuration must be a YAML mapping");
  return saved as Record<string, unknown>;
}
export function config(
  projectRoot: string,
  overrides: Record<string, unknown> = {},
): Config {
  const base = savedConfig(projectRoot);
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  const merged: Record<string, unknown> = { ...base, ...definedOverrides };
  if (definedOverrides.endpoint === null) delete merged.endpoint;
  for (const section of [
    "endpoint",
    "github",
    "agent",
    "reviewer",
    "sandbox",
    "validation",
  ]) {
    const fromFile = base[section];
    const fromOptions = definedOverrides[section];
    if (section === "endpoint" && fromOptions === null) continue;
    if (fromFile || fromOptions)
      merged[section] = {
        ...(fromFile && typeof fromFile === "object" ? fromFile : {}),
        ...(fromOptions && typeof fromOptions === "object" ? fromOptions : {}),
      };
  }
  return schema.parse(merged);
}
