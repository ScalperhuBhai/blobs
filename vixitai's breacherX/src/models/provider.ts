/**
 * Model provider abstraction + router.
 *
 * The blueprint calls for a provider abstraction with per-task model choice,
 * fallbacks, and token/cost tracking. Discovery and verification can route to
 * different models (cheap for triage, strong for reasoning).
 */

import type { Config } from "../config.js";
import type { DiscoveryRequest, DiscoveryResponse } from "../types.js";
import { log } from "../util/logger.js";
import { MockProvider } from "./mock.js";
import { AnthropicProvider } from "./anthropic.js";

export interface ModelProvider {
  readonly name: string;
  readonly modelVersion: string;
  /** Run a specialist discovery pass over one changed file. */
  discover(req: DiscoveryRequest): Promise<DiscoveryResponse>;
}

/** Rough USD cost per 1M tokens, used for the cost trace (planning estimate). */
export interface PriceSheet {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, PriceSheet> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-4-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-opus-4-8": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  mock: { inputPerMTok: 0, outputPerMTok: 0 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const sheet = PRICES[model] ?? PRICES["mock"]!;
  return (
    (inputTokens / 1_000_000) * sheet.inputPerMTok +
    (outputTokens / 1_000_000) * sheet.outputPerMTok
  );
}

/**
 * Select a provider. Falls back to the mock provider if the Anthropic provider
 * is requested but no API key is configured — the pipeline always runs.
 */
export function createProvider(config: Config): ModelProvider {
  if (config.modelProvider === "anthropic") {
    if (!config.anthropicApiKey) {
      log.warn("BREACHERX_MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset; using mock provider.");
      return new MockProvider();
    }
    return new AnthropicProvider(config);
  }
  return new MockProvider();
}
