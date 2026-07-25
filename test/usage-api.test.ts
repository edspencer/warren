import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.js";
import { createRateLimiter } from "../src/review/limits.js";
import type { RateLimits, ReviewResult, TokenUsage } from "../src/types.js";
import { ghResult, makeFakeApp, type FakeAppOptions } from "./fake-app.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-usage-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// makeFakeApp builds a WarrenApp for the HTTP layer but doesn't wire the rate
// limiter (the real container.ts does). Attach a real one over the same history
// store + config so GET /api/usage exercises the true snapshot path.
function makeUsageApp(opts: Partial<FakeAppOptions> = {}) {
  const { app, history } = makeFakeApp({ dataDir, ...opts });
  const rateLimiter = createRateLimiter({
    limits: () => app.config.limits,
    history,
  });
  (app as unknown as { rateLimiter: typeof rateLimiter }).rateLimiter = rateLimiter;
  return { app, history };
}

// A github-pr review result that carries real token usage + a notional cost.
function usageResult(
  over: Parameters<typeof ghResult>[0],
  usage: TokenUsage,
  costUsd: number,
): ReviewResult {
  const r = ghResult(over);
  r.stats.usage = usage;
  r.stats.costUsd = costUsd;
  return r;
}

const tok = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

describe("usage API", () => {
  it("GET /api/usage returns the windowed snapshot shape", async () => {
    const { app } = makeUsageApp();
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Top-level shape: limits + inFlight + the four windows.
    expect(body).toHaveProperty("limits");
    expect(body.inFlight).toBe(0);
    for (const w of ["hour", "day", "month", "allTime"]) {
      expect(body[w]).toEqual({
        reviews: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      });
    }
    // Limits are the all-defaults (no cap) config.
    const limits: RateLimits = body.limits;
    expect(limits.reviewsPerHour).toBe(0);
    expect(limits.tokensPerDay).toBe(0);
    expect(limits.costPerDayUsd).toBe(0);
    await server.close();
  });

  it("GET /api/usage reflects seeded history usage (tokens + notional cost)", async () => {
    const { app, history } = makeUsageApp();
    await history.append(usageResult({ pr: 1 }, tok(1000, 200), 0.5));
    await history.append(usageResult({ pr: 2 }, tok(3000, 800), 1.25));
    const server = createServer(app);

    const res = await server.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Both fresh records fall inside every window; totals aggregate them.
    expect(body.allTime.reviews).toBe(2);
    expect(body.allTime.inputTokens).toBe(4000);
    expect(body.allTime.outputTokens).toBe(1000);
    expect(body.allTime.totalTokens).toBe(5000); // input + output
    expect(body.allTime.costUsd).toBeCloseTo(1.75, 5);

    // Same two records are within the last hour / day / month.
    expect(body.hour.totalTokens).toBe(5000);
    expect(body.day.reviews).toBe(2);
    expect(body.day.costUsd).toBeCloseTo(1.75, 5);
    expect(body.month.totalTokens).toBe(5000);
    await server.close();
  });

  it("GET /api/usage surfaces the active limits from config", async () => {
    const { app } = makeUsageApp();
    app.config.limits = {
      reviewsPerHour: 10,
      reviewsPerDay: 50,
      tokensPerHour: 0,
      tokensPerDay: 2_000_000,
      costPerDayUsd: 25,
    };
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(200);
    const limits: RateLimits = res.json().limits;
    expect(limits.reviewsPerHour).toBe(10);
    expect(limits.tokensPerDay).toBe(2_000_000);
    expect(limits.costPerDayUsd).toBe(25);
    await server.close();
  });

  it("GET /api/usage counts pre-usage records toward reviews but not tokens/cost", async () => {
    const { app, history } = makeUsageApp();
    // An old record with no usage/costUsd (back-compat path).
    await history.append(ghResult({ pr: 7 }));
    await history.append(usageResult({ pr: 8 }, tok(500, 100), 0.2));
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/usage" });
    const body = res.json();
    expect(body.allTime.reviews).toBe(2);
    expect(body.allTime.totalTokens).toBe(600);
    expect(body.allTime.costUsd).toBeCloseTo(0.2, 5);
    await server.close();
  });

  it("GET /api/usage is readable under `none` auth mode (no token required)", async () => {
    const { app } = makeUsageApp({ auth: { mode: "none" } });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    await server.close();
  });

  it("GET /api/usage is guarded (401) in `jwt` mode without a bearer token", async () => {
    const { app } = makeUsageApp({ auth: { mode: "jwt", jwtSecret: "s".repeat(24) } });
    const server = createServer(app);
    const res = await server.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});
