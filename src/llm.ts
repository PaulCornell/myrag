import Anthropic from "@anthropic-ai/sdk";

// Created on first use so the default (free, local) setup never touches Anthropic.
// Resolves credentials from ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile).
let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

// Server-side refusal fallback: if a safety classifier declines, the API re-runs the request on a
// fallback model inside the same call instead of returning an empty answer.
export const FALLBACK_PARAMS = {
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
};

// $ per million tokens (input, output) for cost reporting. Update if you change models.
const PRICING: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export class UsageMeter {
  input = 0;
  output = 0;
  costUsd = 0;
  calls = 0;

  /** Local models are free: anything not in PRICING costs $0. */
  add(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
    const [pin, pout] = PRICING[model] ?? [0, 0];
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    this.calls++;
    this.input += usage.input_tokens + cacheRead + cacheWrite;
    this.output += usage.output_tokens;
    this.costUsd += (usage.input_tokens * pin + cacheRead * pin * 0.1 + cacheWrite * pin * 1.25 + usage.output_tokens * pout) / 1e6;
  }

  toString() {
    return `${this.calls} calls, ${this.input.toLocaleString()} in / ${this.output.toLocaleString()} out tokens, ~$${this.costUsd.toFixed(2)}`;
  }
}
