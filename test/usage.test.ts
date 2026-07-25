import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@herdctl/core";

import {
  addUsage,
  emptyUsage,
  estimateCostUsd,
  extractUsage,
  isKnownModel,
  isZeroUsage,
  priceFor,
  reviewCostUsd,
  totalTokens,
} from "../src/review/usage.js";
import type { TokenUsage } from "../src/types.js";

// ─────────────────────────── Fixtures ───────────────────────────

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over };
}

// A one-Mtok-of-input-only usage, handy for pricing assertions (cost === input rate).
const ONE_MTOK_INPUT: TokenUsage = usage({ inputTokens: 1_000_000 });

// ─────────────────────────── TokenUsage helpers ───────────────────────────

describe("TokenUsage helpers", () => {
  it("emptyUsage is all zeros and reads as zero", () => {
    expect(emptyUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(isZeroUsage(emptyUsage())).toBe(true);
  });

  it("addUsage sums ALL FOUR fields independently", () => {
    const a = usage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 });
    const b = usage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 });
    expect(addUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
    });
    // Pure: inputs are not mutated.
    expect(a.inputTokens).toBe(1);
  });

  it("totalTokens counts input + output ONLY (cache excluded)", () => {
    expect(totalTokens(usage({ inputTokens: 100, outputTokens: 40 }))).toBe(140);
    // Cache tokens do NOT contribute to the billable total.
    expect(
      totalTokens(usage({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 999, cacheCreationTokens: 999 })),
    ).toBe(140);
  });

  it("isZeroUsage is false when ANY field is non-zero", () => {
    expect(isZeroUsage(usage({ inputTokens: 1 }))).toBe(false);
    expect(isZeroUsage(usage({ outputTokens: 1 }))).toBe(false);
    expect(isZeroUsage(usage({ cacheReadTokens: 1 }))).toBe(false);
    expect(isZeroUsage(usage({ cacheCreationTokens: 1 }))).toBe(false);
  });
});

// ─────────────────────────── extractUsage ───────────────────────────

describe("extractUsage", () => {
  it("reads a top-level usage block off a `result` message", () => {
    const m = {
      type: "result",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    } as unknown as SDKMessage;
    expect(extractUsage(m)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
  });

  it("reads a nested `message.usage` block off an `assistant` message", () => {
    const m = {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    } as unknown as SDKMessage;
    expect(extractUsage(m)).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });
  });

  it("returns null when the message carries no usage at all", () => {
    const noUsage = { type: "assistant", message: { content: [] } } as unknown as SDKMessage;
    expect(extractUsage(noUsage)).toBeNull();
    expect(extractUsage({ type: "system" } as unknown as SDKMessage)).toBeNull();
  });

  it("reads absent/non-numeric sub-fields as 0", () => {
    const m = {
      type: "result",
      // only input_tokens present; the other three are absent → 0.
      usage: { input_tokens: 42, cache_read_input_tokens: "oops" },
    } as unknown as SDKMessage;
    expect(extractUsage(m)).toEqual({
      inputTokens: 42,
      outputTokens: 0,
      cacheReadTokens: 0, // non-number coerces to 0
      cacheCreationTokens: 0,
    });
  });
});

// ─────────────────────────── Pricing: priceFor / isKnownModel ───────────────────────────

describe("priceFor / isKnownModel", () => {
  it("matches each known family by keyword substring", () => {
    expect(priceFor("opus").inputPerMtok).toBe(5);
    expect(priceFor("opus").outputPerMtok).toBe(25);
    expect(priceFor("sonnet").inputPerMtok).toBe(3);
    expect(priceFor("sonnet").outputPerMtok).toBe(15);
    expect(priceFor("haiku").inputPerMtok).toBe(1);
    expect(priceFor("haiku").outputPerMtok).toBe(5);
    expect(priceFor("fable").inputPerMtok).toBe(10);
    expect(priceFor("fable").outputPerMtok).toBe(50);
  });

  it("resolves dated ids and minor-version bumps to their family", () => {
    expect(priceFor("claude-haiku-4-5-20251001").inputPerMtok).toBe(1);
    expect(priceFor("claude-sonnet-4-6").inputPerMtok).toBe(3);
    expect(priceFor("claude-opus-4-8").inputPerMtok).toBe(5);
    expect(isKnownModel("claude-haiku-4-5-20251001")).toBe(true);
    expect(isKnownModel("claude-sonnet-4-6")).toBe(true);
    expect(isKnownModel("claude-opus-4-8")).toBe(true);
    expect(isKnownModel("FABLE-XL")).toBe(true); // case-insensitive
  });

  it("cache-read is ≈0.1× the input rate for each family", () => {
    expect(priceFor("opus").cacheReadPerMtok).toBeCloseTo(0.5); // 0.1 × 5
    expect(priceFor("sonnet").cacheReadPerMtok).toBeCloseTo(0.3); // 0.1 × 3
    expect(priceFor("haiku").cacheReadPerMtok).toBeCloseTo(0.1); // 0.1 × 1
    expect(priceFor("fable").cacheReadPerMtok).toBeCloseTo(1); // 0.1 × 10
  });

  it("falls back to OPUS pricing for an unknown model, and reports it as not known", () => {
    expect(isKnownModel("gpt-4o")).toBe(false);
    expect(isKnownModel("")).toBe(false);
    // Conservative-high: unknown prices at the most expensive known family (opus).
    expect(priceFor("gpt-4o")).toEqual(priceFor("opus"));
    expect(priceFor("some-random-model").inputPerMtok).toBe(5);
  });
});

// ─────────────────────────── Pricing: estimateCostUsd / reviewCostUsd ───────────────────────────

describe("estimateCostUsd", () => {
  it("prices 1 Mtok of pure input at exactly the input rate", () => {
    expect(estimateCostUsd(ONE_MTOK_INPUT, "claude-opus-4-8")).toBe(5);
    expect(estimateCostUsd(ONE_MTOK_INPUT, "claude-haiku-4-5")).toBe(1);
    expect(estimateCostUsd(ONE_MTOK_INPUT, "claude-sonnet-4-6")).toBe(3);
    expect(estimateCostUsd(ONE_MTOK_INPUT, "claude-fable")).toBe(10);
  });

  it("prices a mixed input + output usage across both rates (sonnet)", () => {
    // 0.5 Mtok in × $3 + 0.2 Mtok out × $15 = 1.5 + 3.0 = 4.5
    const u = usage({ inputTokens: 500_000, outputTokens: 200_000 });
    expect(estimateCostUsd(u, "claude-sonnet-4-6")).toBeCloseTo(4.5, 10);
  });

  it("prices cache-read tokens at the discounted cache rate (haiku)", () => {
    // 1 Mtok cache-read × $0.1 = 0.1 (and no input/output cost).
    const u = usage({ cacheReadTokens: 1_000_000 });
    expect(estimateCostUsd(u, "claude-haiku-4-5")).toBeCloseTo(0.1, 10);
  });

  it("an unknown model prices at the opus fallback", () => {
    expect(estimateCostUsd(ONE_MTOK_INPUT, "gpt-4o")).toBe(5);
  });

  it("zero usage costs nothing", () => {
    expect(estimateCostUsd(emptyUsage(), "claude-opus-4-8")).toBe(0);
  });
});

describe("reviewCostUsd", () => {
  it("prices the aggregate usage at the REVIEW model", () => {
    // Same usage, different review model → different notional cost.
    expect(reviewCostUsd(ONE_MTOK_INPUT, "claude-opus-4-8")).toBe(5);
    expect(reviewCostUsd(ONE_MTOK_INPUT, "claude-haiku-4-5")).toBe(1);
    // It is exactly estimateCostUsd at the review model.
    const u = usage({ inputTokens: 300_000, outputTokens: 100_000 });
    expect(reviewCostUsd(u, "claude-sonnet-4-6")).toBe(estimateCostUsd(u, "claude-sonnet-4-6"));
  });
});
