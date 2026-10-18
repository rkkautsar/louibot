import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
export const schema = z
  .object({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    model: z.string().regex(/^(openai|anthropic|openai-compatible)\/.+/),
    endpoint: z
      .object({
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
        reasoningEffort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
          .optional(),
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
      inputUsdPerMillion: z.number().nonnegative(),
      outputUsdPerMillion: z.number().nonnegative(),
    }),
    reviewer: z
      .object({
        enabled: z.boolean().default(false),
        model: z
          .string()
          .regex(/^(openai|anthropic|openai-compatible)\/.+/)
          .optional(),
        maxSteps: z.number().int().positive().default(12),
        inputUsdPerMillion: z.number().nonnegative().optional(),
        outputUsdPerMillion: z.number().nonnegative().optional(),
      })
      .default({ enabled: false, maxSteps: 12 }),
    sandbox: z
      .object({
        image: z.string().default("auto"),
        commandTimeoutSeconds: z.number().positive().default(120),
        network: z.enum(["bridge", "none"]).default("bridge"),
      })
      .default({
        image: "auto",
        commandTimeoutSeconds: 120,
        network: "bridge",
      }),
    validation: z
      .object({
        commands: z.array(z.string().min(1).max(2000)).max(20).default([]),
      })
      .default({ commands: [] }),
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
