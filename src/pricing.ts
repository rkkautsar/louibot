export interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
}

// Keep this deliberately small and explicit. OpenAI-compatible endpoints can
// apply negotiated rates, gateway markups, or discounts, so their prices are
// never inferred from the model name.
const openAiPricing: Record<string, Omit<TokenPricing, "source">> = {
  "gpt-6-astra": { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
  "gpt-6-sol": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  "gpt-6-luna": { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
};

export function knownPricing(model: string): TokenPricing | undefined {
  const [, modelId] = model.split(/\/(.+)/, 2);
  if (!model.startsWith("openai/") || !modelId) return undefined;
  const pricing = openAiPricing[modelId];
  return pricing
    ? { ...pricing, source: "OpenAI published standard token pricing" }
    : undefined;
}

export interface TokenRates {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export function reviewerRates(options: {
  model: string;
  implementationModel: string;
  savedModel?: string;
  savedReviewerModel?: string;
  hasSavedRates: boolean;
  explicitRates?: TokenRates;
  implementationRates: TokenRates;
}): TokenRates | undefined {
  if (options.explicitRates) return options.explicitRates;
  const savedModel = options.savedReviewerModel ?? options.savedModel;
  if (options.hasSavedRates && options.model === savedModel) return undefined;
  if (options.model === options.implementationModel)
    return options.implementationRates;
  const pricing = knownPricing(options.model);
  return pricing
    ? {
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
      }
    : undefined;
}
