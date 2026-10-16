import { readFileSync } from "node:fs";
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
            !url.hash
          );
        }, "Use an HTTP(S) base URL without credentials, query, or fragment"),
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
      maxSteps: z.number().int().positive().default(60),
      maxCostUsd: z.number().positive().default(3),
      maxInputTokens: z.number().int().positive().default(32000),
      maxOutputTokens: z.number().int().positive().default(4096),
      inputUsdPerMillion: z.number().nonnegative(),
      outputUsdPerMillion: z.number().nonnegative(),
    }),
    sandbox: z
      .object({
        image: z.string().default("node:22"),
        commandTimeoutSeconds: z.number().positive().default(120),
      })
      .default({ image: "node:22", commandTimeoutSeconds: 120 }),
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
  });
export type Config = z.infer<typeof schema>;
export function config(projectRoot: string): Config {
  return schema.parse(
    parse(readFileSync(`${projectRoot}/.louibot/config.yaml`, "utf8")),
  );
}
