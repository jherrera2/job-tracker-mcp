// The price table and cost estimates (evals/src/cost.ts). The worst case is what the guard compares
// with --max-usd before anything is sent, so it must never come out lower than a real run could cost.
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  costUsd,
  estimateRun,
  estimateTokens,
  priceFor,
  TOOL_RESULTS_MAX_TOKENS,
  TYPICAL_OUTPUT_TOKENS,
} from "../../../evals/src/cost.js";

describe("priceFor", () => {
  it("knows the default model and refuses to guess for an unknown one", () => {
    expect(priceFor("claude-sonnet-5-5")).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(priceFor("claude-opus-5-5")).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(priceFor("some-other-model")).toBeUndefined();
  });
});

describe("estimateTokens", () => {
  it(`rounds characters / ${CHARS_PER_TOKEN_ESTIMATE} up, a deliberate over-estimate for English text`, () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(3_000)).toBe(1_000);
    expect(estimateTokens(3_001)).toBe(1_001);
  });
});

describe("costUsd", () => {
  it("prices input and output tokens per million", () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, { inputPerMTok: 2, outputPerMTok: 10 })).toBe(2);
    expect(costUsd({ inputTokens: 5_000, outputTokens: 2_000 }, { inputPerMTok: 2, outputPerMTok: 10 })).toBeCloseTo(0.03, 10);
  });
});

describe("estimateRun", () => {
  const price = { inputPerMTok: 2, outputPerMTok: 10 };

  it("tool results sent back are capped: 3 results of up to 2,000 characters, plus a fixed overhead per block", () => {
    expect(TOOL_RESULTS_MAX_TOKENS).toBe(Math.ceil((3 * 2_000) / 3) + 3 * 50);
  });

  it("worst case: every case uses every call, every call fills max_tokens, the 2nd call resends reply + capped tool results", () => {
    // One case, 30,000 prompt characters = 10,000 tokens; 2 calls of up to 1,000 output tokens.
    const est = estimateRun([30_000], { maxOutputTokens: 1_000, maxAttempts: 2 }, price);
    const attempt1In = 10_000;
    const attempt2In = 10_000 + 1_000 + TOOL_RESULTS_MAX_TOKENS;
    expect(est.worstInputTokens).toBe(attempt1In + attempt2In);
    expect(est.worstOutputTokens).toBe(2_000);
    expect(est.worstUsd).toBeCloseTo(((attempt1In + attempt2In) * 2 + 2_000 * 10) / 1_000_000, 10);
  });

  it("typical case: one attempt with a typical-length answer, never above the worst case", () => {
    const est = estimateRun([30_000, 30_000], { maxOutputTokens: 8_000, maxAttempts: 2 }, price);
    expect(est.typicalUsd).toBeCloseTo((2 * 10_000 * 2 + 2 * TYPICAL_OUTPUT_TOKENS * 10) / 1_000_000, 10);
    expect(est.typicalUsd).toBeLessThan(est.worstUsd);
  });
});
