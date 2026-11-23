// Prices and cost estimates for an eval run. Pure (test/unit/evals/cost.test.ts).
//
// ASSUMPTIONS (check before trusting a figure):
// - Prices are Anthropic's first-party list prices in USD per million tokens, as cached in the
//   claude-api reference on 2026-11-03. They are not read from the API. Check
//   https://platform.claude.com/docs/en/about-claude/pricing before a real run and update this table.
// - No prompt caching and no batch discount are assumed (each case's prompt is different).
// - Thinking tokens are billed as output tokens; they are inside max_tokens, so the worst case
//   (every call fills max_tokens) already covers them.
// - Input tokens are ESTIMATED as characters / 3, rounded up. English prose is usually closer to
//   4 characters per token, so this over-estimates on purpose. The real counts come back with
//   each response and are what the results file records.

import { LIMITS } from "./args.js";

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-fable-5-2": { inputPerMTok: 8, outputPerMTok: 40 },
};

export function priceFor(model: string): Price | undefined {
  return Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
}

export const CHARS_PER_TOKEN_ESTIMATE = 3;
/** A guess at a typical answer: ~1,000 tokens of JSON plus some thinking. Used for the "typical" figure only. */
export const TYPICAL_OUTPUT_TOKENS = 2_000;
/** Overhead of one tool_result block (type, id, is_error), generously sized. */
export const TOOL_RESULT_OVERHEAD_TOKENS = 50;
/**
 * The most the tool results sent back before a second call can add: at most
 * LIMITS.maxToolCallsPerReply results (a reply with more ends the case), each cut to
 * LIMITS.maxToolResultChars characters (runner.ts). This is what makes the worst case a bound.
 */
export const TOOL_RESULTS_MAX_TOKENS =
  Math.ceil((LIMITS.maxToolCallsPerReply * LIMITS.maxToolResultChars) / CHARS_PER_TOKEN_ESTIMATE) +
  LIMITS.maxToolCallsPerReply * TOOL_RESULT_OVERHEAD_TOKENS;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export function costUsd(usage: { inputTokens: number; outputTokens: number }, price: Price): number {
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}

export interface RunEstimate {
  worstInputTokens: number;
  worstOutputTokens: number;
  worstUsd: number;
  typicalUsd: number;
}

/**
 * `promptChars`: for each case, the characters sent on its first call (system text + prompt).
 * Worst case: every case uses all `maxAttempts` model calls, every reply fills `maxOutputTokens`,
 * and each later call resends the history: the first request, the previous reply (thinking and
 * tool calls included, at most `maxOutputTokens`) and the capped tool results.
 */
export function estimateRun(
  promptChars: readonly number[],
  limits: { maxOutputTokens: number; maxAttempts: number },
  price: Price,
): RunEstimate {
  let worstInputTokens = 0;
  let typicalInputTokens = 0;
  for (const chars of promptChars) {
    const first = estimateTokens(chars);
    typicalInputTokens += first;
    for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
      worstInputTokens += first + (attempt - 1) * (limits.maxOutputTokens + TOOL_RESULTS_MAX_TOKENS);
    }
  }
  const worstOutputTokens = promptChars.length * limits.maxAttempts * limits.maxOutputTokens;
  return {
    worstInputTokens,
    worstOutputTokens,
    worstUsd: costUsd({ inputTokens: worstInputTokens, outputTokens: worstOutputTokens }, price),
    typicalUsd: costUsd(
      { inputTokens: typicalInputTokens, outputTokens: promptChars.length * Math.min(TYPICAL_OUTPUT_TOKENS, limits.maxOutputTokens) },
      price,
    ),
  };
}
