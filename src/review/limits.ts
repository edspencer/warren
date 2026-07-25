// src/review/limits.ts — time-windowed rate limits (cost / runaway-loop protection).
//
// Two layers:
//   • PURE window math + limit evaluation (sumWindow / evaluateLimits) — trivially
//     unit-testable, no I/O, no clock;
//   • a stateful RateLimiter that reads completed reviews from the history store,
//     tracks in-flight reservations, and admits/denies a review BEFORE it spends any
//     tokens (called from the pipeline right before the review agent runs).
//
// SCOPE: limits are SERVER-LEVEL and GLOBAL — a single fleet-wide ceiling over every
// watched repo (like `concurrency`), NOT per-repo. A per-repo `overrides.limits` is
// intentionally ignored in v1 (documented in the schema/README). This matches the ask:
// stop WARREN (the whole bot) from consuming too many tokens.
//
// COMMAND POLICY (principled split):
//   • count windows (reviewsPerHour/Day) are NOISE control — an explicit @warren command
//     is a human override and bypasses them (consistent with the other scope filters);
//   • spend windows (tokensPer*, costPerDay) are a HARD budget ceiling — they apply even
//     to commands, because the whole point is to cap token/$ burn.

import type { HistoryRecord, ReviewHistoryStore } from "../state/history.js";
import type { Logger, RateLimits } from "../types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

// ─────────────────────────── Pure window math ───────────────────────────

export interface WindowUsage {
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number; // input + output
  costUsd: number;
}

export function emptyWindow(): WindowUsage {
  return { reviews: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

/**
 * Sum every history record whose timestamp is >= `sinceMs` into a WindowUsage.
 * Records predating the usage-tracking feature (no `usage`/`costUsd`) count toward the
 * review COUNT but contribute 0 tokens/cost — a conservative, non-throwing read.
 */
export function sumWindow(records: HistoryRecord[], sinceMs: number): WindowUsage {
  const w = emptyWindow();
  for (const r of records) {
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    w.reviews += 1;
    const inTok = r.usage?.inputTokens ?? 0;
    const outTok = r.usage?.outputTokens ?? 0;
    w.inputTokens += inTok;
    w.outputTokens += outTok;
    w.totalTokens += inTok + outTok;
    w.costUsd += r.costUsd ?? 0;
  }
  return w;
}

/** True when at least one limit field is a real (positive) cap. */
export function anyLimitSet(l: RateLimits): boolean {
  return (
    l.reviewsPerHour > 0 ||
    l.reviewsPerDay > 0 ||
    l.tokensPerHour > 0 ||
    l.tokensPerDay > 0 ||
    l.costPerDayUsd > 0
  );
}

/**
 * Evaluate the active limits against the completed-review records + in-flight count.
 * Returns a human-readable reason string when a review should be DENIED, else null.
 *
 * `inFlight` = reviews already admitted this window but not yet recorded in history; it
 * counts toward the review-COUNT windows only (their token spend isn't known until they
 * finish, so token/cost windows can overshoot by at most `concurrency` reviews — an
 * accepted bound, documented).
 */
export function evaluateLimits(args: {
  limits: RateLimits;
  now: number;
  records: HistoryRecord[];
  inFlight: number;
  isCommand: boolean;
}): string | null {
  const { limits, now, records, inFlight, isCommand } = args;
  const hour = sumWindow(records, now - HOUR_MS);
  const day = sumWindow(records, now - DAY_MS);

  // Spend-based ceilings — HARD, apply even to explicit commands.
  if (limits.tokensPerHour > 0 && hour.totalTokens >= limits.tokensPerHour) {
    return `tokens/hour ${hour.totalTokens} ≥ limit ${limits.tokensPerHour}`;
  }
  if (limits.tokensPerDay > 0 && day.totalTokens >= limits.tokensPerDay) {
    return `tokens/day ${day.totalTokens} ≥ limit ${limits.tokensPerDay}`;
  }
  if (limits.costPerDayUsd > 0 && day.costUsd >= limits.costPerDayUsd) {
    return `cost/day $${day.costUsd.toFixed(2)} ≥ limit $${limits.costPerDayUsd.toFixed(2)}`;
  }

  // Count-based windows — noise control; an explicit command bypasses them.
  if (!isCommand) {
    const hReviews = hour.reviews + inFlight;
    const dReviews = day.reviews + inFlight;
    if (limits.reviewsPerHour > 0 && hReviews >= limits.reviewsPerHour) {
      return `reviews/hour ${hReviews} ≥ limit ${limits.reviewsPerHour}`;
    }
    if (limits.reviewsPerDay > 0 && dReviews >= limits.reviewsPerDay) {
      return `reviews/day ${dReviews} ≥ limit ${limits.reviewsPerDay}`;
    }
  }
  return null;
}

// ─────────────────────────── Stateful limiter ───────────────────────────

/** A point-in-time view of windowed usage + the active limits (powers /api/usage). */
export interface UsageSnapshot {
  limits: RateLimits;
  inFlight: number;
  hour: WindowUsage;
  day: WindowUsage;
  month: WindowUsage;
  allTime: WindowUsage;
}

export type AdmitResult =
  | { admitted: true; release: () => void }
  | { admitted: false; reason: string };

export interface RateLimiter {
  /**
   * Decide whether a review may proceed. On admit, atomically RESERVES an in-flight
   * slot and returns a `release()` the caller MUST invoke when the review finishes
   * (success or failure). On deny, returns the reason (no reservation).
   */
  tryAdmit(opts: { isCommand: boolean }): Promise<AdmitResult>;
  /** Windowed usage + active limits for the dashboard. */
  snapshot(): Promise<UsageSnapshot>;
}

export interface RateLimiterDeps {
  /** Resolver (not a snapshot) so config hot-reload — which REPLACES `config.limits` by
   *  reference (see reloadWarrenConfigInto) — is picked up on the next check. */
  limits: () => RateLimits;
  history: ReviewHistoryStore;
  now?: () => number;
  logger?: Logger;
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const now = deps.now ?? ((): number => Date.now());
  let inFlight = 0;

  const reserve = (): (() => void) => {
    inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    };
  };

  return {
    async tryAdmit({ isCommand }): Promise<AdmitResult> {
      const limits = deps.limits();
      // No limits configured → admit without even reading history.
      if (!anyLimitSet(limits)) return { admitted: true, release: () => {} };

      const records = await deps.history.all();
      // From here on it's SYNCHRONOUS (no await), so evaluate→reserve is atomic under
      // Node's single-threaded model — two concurrent admits can't both slip a cap.
      const reason = evaluateLimits({
        limits,
        now: now(),
        records,
        inFlight,
        isCommand,
      });
      if (reason) {
        deps.logger?.debug(`rate-limit: denied (${reason})`);
        return { admitted: false, reason };
      }
      return { admitted: true, release: reserve() };
    },

    async snapshot(): Promise<UsageSnapshot> {
      const records = await deps.history.all();
      const t = now();
      return {
        limits: deps.limits(),
        inFlight,
        hour: sumWindow(records, t - HOUR_MS),
        day: sumWindow(records, t - DAY_MS),
        month: sumWindow(records, t - MONTH_MS),
        allTime: sumWindow(records, 0),
      };
    },
  };
}
