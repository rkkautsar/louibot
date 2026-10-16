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
