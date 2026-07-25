import { describe, expect, it } from "vitest";

import {
  anyLimitSet,
  createRateLimiter,
  emptyWindow,
  evaluateLimits,
  sumWindow,
} from "../src/review/limits.js";
import type { HistoryRecord, ReviewHistoryStore } from "../src/state/history.js";
import type { RateLimits, TokenUsage } from "../src/types.js";

// ─────────────────────────── Fixtures ───────────────────────────

const FIXED_MS = Date.parse("2026-07-24T12:00:00.000Z");
const HOUR = 3_600_000;

function iso(msAgo: number): string {
  return new Date(FIXED_MS - msAgo).toISOString();
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over };
}

/** Build a HistoryRecord fixture. `usage`/`costUsd` are left OFF unless provided. */
function record(over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    targetKey: "github:acme/widgets#1",
    kind: "github-pr",
    repo: "acme/widgets",
    prNumber: 1,
    headSha: "abc",
    timestamp: iso(0),
    model: "claude-opus-4-8",
    wallMs: 1000,
    stats: {
      filesReviewed: 1,
      hunksReviewed: 1,
      findingsRaw: 0,
      findingsVerified: 0,
      findingsPosted: 0,
      coverage: "c",
    },
    summary: "s",
    walkthrough: "w",
    findings: [],
    ...over,
  };
}

const NO_LIMITS: RateLimits = {
  reviewsPerHour: 0,
  reviewsPerDay: 0,
  tokensPerHour: 0,
  tokensPerDay: 0,
  costPerDayUsd: 0,
};

function limits(over: Partial<RateLimits> = {}): RateLimits {
  return { ...NO_LIMITS, ...over };
}

/** A fake history store that just replays a fixed record list. */
function fakeHistory(records: HistoryRecord[]): ReviewHistoryStore {
  return { all: async () => records } as unknown as ReviewHistoryStore;
}

// ─────────────────────────── sumWindow ───────────────────────────

describe("sumWindow", () => {
  it("is empty for no records", () => {
    expect(sumWindow([], FIXED_MS - HOUR)).toEqual(emptyWindow());
  });

  it("excludes records older than sinceMs, includes those at/after it", () => {
    const recs = [
      record({ timestamp: iso(0), usage: usage({ inputTokens: 10, outputTokens: 5 }), costUsd: 1 }),
      record({ timestamp: iso(HOUR - 1), usage: usage({ inputTokens: 100, outputTokens: 50 }), costUsd: 2 }),
      // Older than the 1h window → dropped entirely.
      record({ timestamp: iso(HOUR + 1), usage: usage({ inputTokens: 999, outputTokens: 999 }), costUsd: 99 }),
    ];
    const w = sumWindow(recs, FIXED_MS - HOUR);
    expect(w.reviews).toBe(2);
    expect(w.inputTokens).toBe(110);
    expect(w.outputTokens).toBe(55);
    expect(w.totalTokens).toBe(165);
    expect(w.costUsd).toBe(3);
  });

  it("counts a record with NO usage/costUsd toward reviews but contributes 0 tokens/cost", () => {
    const recs = [
      record({ usage: usage({ inputTokens: 10, outputTokens: 5 }), costUsd: 0.5 }),
      record(), // pre-feature record: no usage, no costUsd
    ];
    const w = sumWindow(recs, FIXED_MS - HOUR);
    expect(w.reviews).toBe(2);
    expect(w.inputTokens).toBe(10);
    expect(w.outputTokens).toBe(5);
    expect(w.totalTokens).toBe(15);
    expect(w.costUsd).toBe(0.5);
  });
});

// ─────────────────────────── anyLimitSet ───────────────────────────

describe("anyLimitSet", () => {
  it("is false when every field is 0", () => {
    expect(anyLimitSet(NO_LIMITS)).toBe(false);
  });

  it("is true when any single field is a positive cap", () => {
    expect(anyLimitSet(limits({ reviewsPerHour: 1 }))).toBe(true);
    expect(anyLimitSet(limits({ reviewsPerDay: 1 }))).toBe(true);
    expect(anyLimitSet(limits({ tokensPerHour: 1 }))).toBe(true);
    expect(anyLimitSet(limits({ tokensPerDay: 1 }))).toBe(true);
    expect(anyLimitSet(limits({ costPerDayUsd: 1 }))).toBe(true);
  });
});

// ─────────────────────────── evaluateLimits ───────────────────────────

describe("evaluateLimits", () => {
  const base = { now: FIXED_MS, inFlight: 0, isCommand: false };

  it("returns null when under every configured cap", () => {
    const recs = [record({ usage: usage({ inputTokens: 100, outputTokens: 50 }), costUsd: 1 })];
    const reason = evaluateLimits({
      ...base,
      records: recs,
      limits: limits({ reviewsPerHour: 10, tokensPerHour: 10_000, costPerDayUsd: 100 }),
    });
    expect(reason).toBeNull();
  });

  it("denies with a reason string when over each individual cap", () => {
    const recs = [record({ usage: usage({ inputTokens: 100, outputTokens: 50 }), costUsd: 5 })];
    // reviews/hour: 1 review >= 1
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ reviewsPerHour: 1 }) }),
    ).toMatch(/reviews\/hour/);
    // reviews/day
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ reviewsPerDay: 1 }) }),
    ).toMatch(/reviews\/day/);
    // tokens/hour: total 150 >= 150
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ tokensPerHour: 150 }) }),
    ).toMatch(/tokens\/hour/);
    // tokens/day
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ tokensPerDay: 150 }) }),
    ).toMatch(/tokens\/day/);
    // cost/day: $5 >= $5
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ costPerDayUsd: 5 }) }),
    ).toMatch(/cost\/day/);
  });

  it("treats the boundary as DENIED (>=): exactly-at-limit blocks", () => {
    const recs = [record({ usage: usage({ inputTokens: 100, outputTokens: 50 }), costUsd: 3 })];
    // Exactly at the token cap → denied.
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ tokensPerHour: 150 }) }),
    ).not.toBeNull();
    // One above the cap → allowed.
    expect(
      evaluateLimits({ ...base, records: recs, limits: limits({ tokensPerHour: 151 }) }),
    ).toBeNull();
  });

  it("BYPASSES count windows for an explicit command, but still enforces spend windows", () => {
    const recs = [
      record({ usage: usage({ inputTokens: 1000, outputTokens: 500 }), costUsd: 20 }),
      record({ usage: usage({ inputTokens: 1000, outputTokens: 500 }), costUsd: 20 }),
    ];
    // Count windows would deny (2 reviews >= 1), but a command bypasses them.
    expect(
      evaluateLimits({
        ...base,
        isCommand: true,
        records: recs,
        limits: limits({ reviewsPerHour: 1, reviewsPerDay: 1 }),
      }),
    ).toBeNull();
    // A spend window (tokens) is a HARD ceiling — a command does NOT bypass it.
    expect(
      evaluateLimits({
        ...base,
        isCommand: true,
        records: recs,
        limits: limits({ tokensPerHour: 100 }),
      }),
    ).toMatch(/tokens\/hour/);
    // Same for cost/day.
    expect(
      evaluateLimits({
        ...base,
        isCommand: true,
        records: recs,
        limits: limits({ costPerDayUsd: 10 }),
      }),
    ).toMatch(/cost\/day/);
  });

  it("adds inFlight to count windows ONLY (spend windows ignore it)", () => {
    // Empty history + 1 in-flight review → hits a reviewsPerHour=1 cap.
    expect(
      evaluateLimits({ ...base, inFlight: 1, records: [], limits: limits({ reviewsPerHour: 1 }) }),
    ).toMatch(/reviews\/hour/);
    // The same in-flight review contributes NO tokens, so a token cap is unaffected.
    expect(
      evaluateLimits({ ...base, inFlight: 5, records: [], limits: limits({ tokensPerHour: 1 }) }),
    ).toBeNull();
  });
});

// ─────────────────────────── createRateLimiter ───────────────────────────

describe("createRateLimiter", () => {
  const now = (): number => FIXED_MS;

  it("admits on the no-limits fast path WITHOUT reading history", async () => {
    const throwingHistory = {
      all: async () => {
        throw new Error("history should not be read on the no-limits fast path");
      },
    } as unknown as ReviewHistoryStore;
    const rl = createRateLimiter({ limits: () => NO_LIMITS, history: throwingHistory, now });
    const admit = await rl.tryAdmit({ isCommand: false });
    expect(admit.admitted).toBe(true);
  });

  it("denies when the window is over a configured cap", async () => {
    const recs = [record({ usage: usage({ inputTokens: 10, outputTokens: 5 }) })];
    const rl = createRateLimiter({
      limits: () => limits({ reviewsPerHour: 1 }),
      history: fakeHistory(recs),
      now,
    });
    const admit = await rl.tryAdmit({ isCommand: false });
    expect(admit.admitted).toBe(false);
    if (!admit.admitted) expect(admit.reason).toMatch(/reviews\/hour/);
  });

  it("reserves an in-flight slot on admit, and release() frees it", async () => {
    const rl = createRateLimiter({
      limits: () => limits({ reviewsPerHour: 10 }),
      history: fakeHistory([]),
      now,
    });
    expect((await rl.snapshot()).inFlight).toBe(0);

    const admit = await rl.tryAdmit({ isCommand: false });
    expect(admit.admitted).toBe(true);
    // The reservation is visible in the snapshot.
    expect((await rl.snapshot()).inFlight).toBe(1);

    if (admit.admitted) admit.release();
    expect((await rl.snapshot()).inFlight).toBe(0);

    // release() is idempotent — a double call does not underflow.
    if (admit.admitted) admit.release();
    expect((await rl.snapshot()).inFlight).toBe(0);
  });

  it("admits exactly ONE of two concurrent tryAdmit calls under reviewsPerHour=1", async () => {
    const rl = createRateLimiter({
      limits: () => limits({ reviewsPerHour: 1 }),
      history: fakeHistory([]),
      now,
    });
    const [a, b] = await Promise.all([
      rl.tryAdmit({ isCommand: false }),
      rl.tryAdmit({ isCommand: false }),
    ]);
    const admitted = [a, b].filter((r) => r.admitted);
    expect(admitted).toHaveLength(1); // atomic check+reserve — no cap slip
    expect((await rl.snapshot()).inFlight).toBe(1);
  });

  it("re-reads the limits resolver on every call (hot-reload)", async () => {
    // One review in the last hour; a resolver returning a MUTABLE limits object.
    const recs = [record({ timestamp: iso(0) })];
    const current: RateLimits = limits(); // starts with NO caps
    const rl = createRateLimiter({ limits: () => current, history: fakeHistory(recs), now });

    // No caps → admitted.
    expect((await rl.tryAdmit({ isCommand: false })).admitted).toBe(true);

    // Mutate the same object to introduce a cap the existing record already exceeds.
    current.reviewsPerHour = 1;
    const after = await rl.tryAdmit({ isCommand: false });
    expect(after.admitted).toBe(false); // the new limit took effect on the next check
  });
});
