import {
  ChatOpenAI,
  ChatOpenAICompletions,
  ChatOpenAIResponses,
} from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { AIMessageChunk } from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import type { Config } from "./config.js";

export const MALFORMED_TOOL_CALL = "LOUIBOT_MALFORMED_TOOL_CALL";

const MAX_SHELL_TOOL_ARGUMENT_CHARS = 48_000;
const MAX_CONSECUTIVE_SHELL_ARGUMENT_WHITESPACE = 2_000;
const MIN_REPEATED_ARGUMENT_UNIT = 2;
const MAX_REPEATED_ARGUMENT_UNIT = 16;
const MIN_ARGUMENT_UNIT_REPETITIONS = 400;
const REPEATED_ARGUMENT_TAIL_CHARS =
  MAX_REPEATED_ARGUMENT_UNIT * MIN_ARGUMENT_UNIT_REPETITIONS;
const REPEATED_ARGUMENT_CHECK_INTERVAL = 256;

function hasRepeatedArgumentSuffix(value: string): boolean {
  if (value.length < MIN_REPEATED_ARGUMENT_UNIT * MIN_ARGUMENT_UNIT_REPETITIONS)
    return false;
  for (
    let unitLength = MIN_REPEATED_ARGUMENT_UNIT;
    unitLength <= MAX_REPEATED_ARGUMENT_UNIT;
    unitLength++
  ) {
    const unit = value.slice(-unitLength);
    if (/\s/.test(unit)) continue;
    let repetitions = 1;
    while (
      repetitions < MIN_ARGUMENT_UNIT_REPETITIONS &&
      value.slice(
        -(repetitions + 1) * unitLength,
        -repetitions * unitLength,
      ) === unit
    )
      repetitions++;
    if (repetitions >= MIN_ARGUMENT_UNIT_REPETITIONS) return true;
  }
  return false;
}

function runawayToolCallError(reason: string): Error {
  const error = new Error(
    `The streamed shell tool call was stopped because ${reason}. Louibot will make one recovery attempt.`,
  );
  error.name = MALFORMED_TOOL_CALL;
  return error;
}

class GuardedChatOpenAIResponses extends ChatOpenAIResponses {
  override async *_streamResponseChunks(
    ...args: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>
  ): AsyncGenerator<ChatGenerationChunk> {
    const [messages, options, runManager] = args;
    const argumentState = new Map<
      number,
      {
        name?: string;
        chars: number;
        whitespaceRun: number;
        tail: string;
        nextCycleCheckAt: number;
      }
    >();

    for await (const chunk of super._streamResponseChunks(
      messages,
      options,
      runManager,
    )) {
      const message = chunk.message as AIMessageChunk;
      for (const toolCall of message.tool_call_chunks ?? []) {
        const index = toolCall.index ?? 0;
        const state = argumentState.get(index) ?? {
          chars: 0,
          whitespaceRun: 0,
          tail: "",
          nextCycleCheckAt:
            MIN_REPEATED_ARGUMENT_UNIT * MIN_ARGUMENT_UNIT_REPETITIONS,
        };
        if (toolCall.name) state.name = toolCall.name;

        if (state.name === "shell" && typeof toolCall.args === "string") {
          state.chars += toolCall.args.length;
          for (const character of toolCall.args) {
            state.whitespaceRun = /\s/.test(character)
              ? state.whitespaceRun + 1
              : 0;
            if (
              state.whitespaceRun >= MAX_CONSECUTIVE_SHELL_ARGUMENT_WHITESPACE
            )
              throw runawayToolCallError(
                `it contained at least ${MAX_CONSECUTIVE_SHELL_ARGUMENT_WHITESPACE} consecutive whitespace characters`,
              );
          }
          if (state.chars > MAX_SHELL_TOOL_ARGUMENT_CHARS)
            throw runawayToolCallError(
              `its arguments exceeded ${MAX_SHELL_TOOL_ARGUMENT_CHARS} characters`,
            );
          state.tail = (state.tail + toolCall.args).slice(
            -REPEATED_ARGUMENT_TAIL_CHARS,
          );
          if (state.chars >= state.nextCycleCheckAt) {
            state.nextCycleCheckAt =
              state.chars + REPEATED_ARGUMENT_CHECK_INTERVAL;
            if (hasRepeatedArgumentSuffix(state.tail))
              throw runawayToolCallError(
                "its arguments repeated the same short sequence at least 400 times",
              );
          }
        }
        argumentState.set(index, state);
      }
      yield chunk;
    }
  }
}

export function createModel(
  config: Config,
  model = config.model,
  maxTokens = config.agent.maxOutputTokens,
) {
  const [provider, ...modelIdParts] = model.split("/");
  const modelId = modelIdParts.join("/");
  const modelOptions = {
    model: modelId,
    maxTokens,
    maxRetries: 0,
    timeout: config.agent.modelRequestTimeoutSeconds * 1000,
  };
  if (provider === "openai-compatible") {
    if (!config.endpoint)
      throw new Error("Missing compatible endpoint configuration");
    const apiKey = process.env[config.endpoint.apiKeyEnv];
    if (!apiKey)
      throw new Error(
        `Set ${config.endpoint.apiKeyEnv} in the host environment`,
      );
    if (config.endpoint.apiFormat === "responses")
      return new GuardedChatOpenAIResponses({
        ...modelOptions,
        streaming: true,
        modelKwargs: config.endpoint.reasoningEffort
          ? { reasoning: { effort: config.endpoint.reasoningEffort } }
          : {},
        apiKey,
        configuration: { baseURL: config.endpoint.baseUrl },
        streamUsage: false,
      });
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
