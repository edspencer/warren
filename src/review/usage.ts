// src/review/usage.ts — token-usage aggregation + a per-model list-price table.
//
// Two pure concerns, both side-effect-free and unit-testable:
//   • TokenUsage helpers (empty/add/total) + extraction from a (loosely-typed)
//     herdctl SDKMessage — used by herd/run.ts to report REAL tokens per agent turn;
//   • pricing: map a model id → USD/Mtok list prices and compute a NOTIONAL cost.
//
// COST FRAMING: Warren runs agents on the CLI runtime (Max-plan billing path), which
// bills flat, not per-token. The dollar figures here are therefore NOTIONAL — computed
// from published list prices purely as a budgeting / runaway-loop signal (and to power
// the cost-per-day rate limit). They are not an invoice. The CLI runtime also reports
// only input/output tokens (no cache breakdown), so the cache fields are 0 there; the
// math still handles them for a future SDK runtime that does report cache usage.

import type { SDKMessage } from "@herdctl/core";
import type { TokenUsage } from "../types.js";

// ─────────────────────────── TokenUsage helpers ───────────────────────────

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Billable-ish token total used by the tokens/hour|day windows: input + output. */
export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens;
}

export function isZeroUsage(u: TokenUsage): boolean {
  return (
    u.inputTokens === 0 &&
    u.outputTokens === 0 &&
    u.cacheReadTokens === 0 &&
    u.cacheCreationTokens === 0
  );
}

/** Read a numeric field defensively off a loosely-typed record. */
function num(o: Record<string, unknown> | undefined, k: string): number {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Extract a TokenUsage from a single herdctl SDKMessage, or null if it carries none.
 * Usage lives either at the message top level (the `result` message) or nested under
 * `message.usage` (an `assistant` message). Field names follow the Anthropic API
 * (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`). Anything absent reads as 0.
 */
export function extractUsage(m: SDKMessage): TokenUsage | null {
  if (!m || typeof m !== "object") return null;
  const top = (m as { usage?: unknown }).usage;
  const nested = (m as { message?: { usage?: unknown } }).message?.usage;
  const raw = (top ?? nested) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  return {
    inputTokens: num(raw, "input_tokens"),
    outputTokens: num(raw, "output_tokens"),
    cacheReadTokens: num(raw, "cache_read_input_tokens"),
    cacheCreationTokens: num(raw, "cache_creation_input_tokens"),
  };
}

// ─────────────────────────── Pricing ───────────────────────────

/** USD per MILLION tokens. Cache prices are the standard multipliers off input. */
export interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number; // ≈ 0.1× input
  cacheWritePerMtok: number; // 5-min TTL write, ≈ 1.25× input
}

/**
 * Known-model list prices (verified against the Anthropic pricing reference, 2026-07).
 * Keyed by MODEL FAMILY so a dated id (`claude-haiku-4-5-20251001`) or a minor bump
 * (`claude-sonnet-4-6`) still resolves. Sonnet uses the steady-state $3/$15 (its intro
 * rate reverts 2026-08-31; over-estimating during intro is fine for a budget signal).
 */
const FAMILY_PRICES: Record<string, ModelPrice> = {
  opus: { inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25 },
  sonnet: { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 },
  haiku: { inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25 },
  fable: { inputPerMtok: 10, outputPerMtok: 50, cacheReadPerMtok: 1, cacheWritePerMtok: 12.5 },
};

/**
 * Fallback for an UNKNOWN model id. Deliberately the most expensive known family
 * (opus) so an unrecognized model can never make the budget ceiling under-count — a
 * cost limit fails safe (conservative-high) rather than silently letting spend through.
 */
const FALLBACK_PRICE: ModelPrice = FAMILY_PRICES.opus;

/** Resolve a model id to its list price by family keyword; unknown → FALLBACK_PRICE. */
export function priceFor(model: string): ModelPrice {
  const id = (model ?? "").toLowerCase();
  for (const family of Object.keys(FAMILY_PRICES)) {
    if (id.includes(family)) return FAMILY_PRICES[family];
  }
  return FALLBACK_PRICE;
}

/** True when the model id matched a known family (vs. fell back to opus pricing). */
export function isKnownModel(model: string): boolean {
  const id = (model ?? "").toLowerCase();
  return Object.keys(FAMILY_PRICES).some((f) => id.includes(f));
}

/** Notional USD cost of `usage` at `model`'s list price (see COST FRAMING above). */
export function estimateCostUsd(usage: TokenUsage, model: string): number {
  const p = priceFor(model);
  const per = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
  return (
    per(usage.inputTokens, p.inputPerMtok) +
    per(usage.outputTokens, p.outputPerMtok) +
    per(usage.cacheReadTokens, p.cacheReadPerMtok) +
    per(usage.cacheCreationTokens, p.cacheWritePerMtok)
  );
}

/**
 * Cost of a whole review whose token usage is split across passes on DIFFERENT models.
 * We don't retain per-pass usage separately (only the summed TokenUsage), so this prices
 * the aggregate at the review model — the dominant cost by far (Opus review vs. Haiku
 * triage/verify). Documented as an approximation; exact per-pass costing would require
 * threading per-pass usage through, which isn't worth the plumbing for a notional figure.
 */
export function reviewCostUsd(usage: TokenUsage, reviewModel: string): number {
  return estimateCostUsd(usage, reviewModel);
}
