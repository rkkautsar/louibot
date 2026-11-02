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

function normalizeResponsesPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("output" in payload)) return;
  const output = payload.output;
  if (!Array.isArray(output)) return;
  for (const item of output) {
    if (!item || typeof item !== "object" || !("type" in item)) continue;
    if (item.type !== "message" || !("content" in item)) continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || !("type" in part)) continue;
      if (part.type !== "output_text") continue;
      if (!("annotations" in part) || !Array.isArray(part.annotations))
        Object.assign(part, { annotations: [] });
    }
  }
}

function normalizeResponsesEvent(event: unknown) {
  if (!event || typeof event !== "object") return;
  if ("response" in event) normalizeResponsesPayload(event.response);
  if ("item" in event) normalizeResponsesPayload({ output: [event.item] });
}

function wrapResponsesStream(stream: unknown) {
  if (!stream || typeof stream !== "object") return stream;
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator)
        return async function* () {
          // Proxy target is the SDK stream, which is async iterable.
          const iterable = target as AsyncIterable<unknown>;
          for await (const event of iterable) {
            normalizeResponsesEvent(event);
            yield event;
          }
        };
      return Reflect.get(target, property, receiver);
    },
  });
}

class GuardedChatOpenAIResponses extends ChatOpenAIResponses {
  constructor(fields: ConstructorParameters<typeof ChatOpenAIResponses>[0]) {
    super(fields);
    // Some OpenAI-compatible providers omit empty annotation arrays, while
    // LangChain's Responses converter assumes the field is present. Wrap the
    // retry method so both streaming and non-streaming results are normalized
    // before conversion runs.
    const original = this.completionWithRetry.bind(this) as unknown as (
      request: unknown,
      options?: unknown,
    ) => Promise<unknown>;
    Object.defineProperty(this, "completionWithRetry", {
      configurable: true,
      value: async (request: unknown, options?: unknown) => {
        const result = await original(request, options);
        if (
          request &&
          typeof request === "object" &&
          "stream" in request &&
          request.stream
        )
          return wrapResponsesStream(result);
        normalizeResponsesPayload(result);
        return result;
      },
    });
  }

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

export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function createModel(
  config: Config,
  model = config.model,
  maxTokens = config.agent.maxOutputTokens,
  options: {
    apiFormat?: "chat-completions" | "responses";
    reasoningEffort?: ReasoningEffort;
  } = {},
) {
  const [provider, ...modelIdParts] = model.split("/");
  const modelId = modelIdParts.join("/");
  const apiFormat =
    options.apiFormat ?? config.endpoint?.apiFormat ?? "responses";
  const reasoningEffort =
    options.reasoningEffort ?? config.endpoint?.reasoningEffort;
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
    if (apiFormat === "responses")
      return new GuardedChatOpenAIResponses({
        ...modelOptions,
        streaming: true,
        modelKwargs: reasoningEffort
          ? { reasoning: { effort: reasoningEffort } }
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
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
