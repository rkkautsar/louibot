import { ChatOpenAI, ChatOpenAICompletions } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { Config } from "./config.js";

export function createModel(config: Config) {
  const [provider, ...modelIdParts] = config.model.split("/");
  const modelId = modelIdParts.join("/");
  const modelOptions = {
    model: modelId,
    maxTokens: config.agent.maxOutputTokens,
    maxRetries: 0,
  };
  if (provider === "openai-compatible") {
    if (!config.endpoint)
      throw new Error("Missing compatible endpoint configuration");
    const apiKey = process.env[config.endpoint.apiKeyEnv];
    if (!apiKey)
      throw new Error(
        `Set ${config.endpoint.apiKeyEnv} in the host environment`,
      );
    // Use Chat Completions explicitly: compatible services need not support Responses.
    const modernOpenAI = /(^|\/)(gpt-[5-9](?:[.-]|$)|o[1-9](?:[.-]|$))/.test(
      modelId,
    );
    const completionLimit =
      config.endpoint.tokenLimitParameter === "max_completion_tokens" ||
      (!config.endpoint.tokenLimitParameter && modernOpenAI);
    return new ChatOpenAICompletions({
      ...modelOptions,
      maxTokens: completionLimit ? -1 : modelOptions.maxTokens,
      modelKwargs: {
        ...(completionLimit
          ? { max_completion_tokens: modelOptions.maxTokens }
          : {}),
        ...(config.endpoint.reasoningEffort
          ? { reasoning_effort: config.endpoint.reasoningEffort }
          : {}),
      },
      apiKey,
      configuration: { baseURL: config.endpoint.baseUrl },
      streamUsage: false,
    });
  }
  return provider === "openai"
    ? new ChatOpenAI(modelOptions)
    : new ChatAnthropic(modelOptions);
}
