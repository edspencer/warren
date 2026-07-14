// test/fake-app.ts — a minimal WarrenApp good enough to exercise the HTTP layer
// (dashboard API + auth) via Fastify .inject(), without booting the fleet/trigger.

import type { WarrenApp } from "../src/container.js";
import type { WarrenAuthConfig } from "../src/config/env.js";
import { createReviewHistoryStore, type ReviewHistoryStore } from "../src/state/history.js";
import type { Finding, Logger, ReviewResult, ReviewTarget } from "../src/types.js";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    path: "src/a.ts",
    line: 12,
    side: "RIGHT",
    severity: "high",
    category: "bug",
    title: "Null deref",
    body: "…",
    confidence: 0.88,
    fingerprint: "fp-" + Math.random().toString(36).slice(2),
    verified: true,
    ...over,
  };
}

export function ghResult(over: {
  owner?: string;
  name?: string;
  pr?: number;
  findings?: Finding[];
} = {}): ReviewResult {
  const target: ReviewTarget = {
    kind: "github-pr",
    repo: { owner: over.owner ?? "acme", name: over.name ?? "widgets" },
    prNumber: over.pr ?? 7,
    headSha: "abc1234def",
    baseSha: "base",
    baseRef: "main",
  };
  const findings = over.findings ?? [makeFinding()];
  return {
    target,
    summary: "summary",
    walkthrough: "walkthrough",
    findings,
    stats: {
      filesReviewed: 3,
      hunksReviewed: 5,
      findingsRaw: findings.length + 2,
      findingsVerified: findings.length,
      findingsPosted: findings.length,
      coverage: "Reviewed 3 files.",
      durationMs: 3000,
      triageModel: "t",
      reviewModel: "claude-opus-4",
      verifyModel: "v",
    },
    posted: findings.length > 0,
  };
}

export interface FakeAppOptions {
  dataDir: string;
  auth?: WarrenAuthConfig;
  repos?: WarrenApp["repos"];
}

/** Build a fake WarrenApp with a real history store; other deps are stubs. */
export function makeFakeApp(opts: FakeAppOptions): {
  app: WarrenApp;
  history: ReviewHistoryStore;
} {
  const history = createReviewHistoryStore(opts.dataDir);
  const auth: WarrenAuthConfig = opts.auth ?? { mode: "none" };
  const app = {
    history,
    dataDir: opts.dataDir,
    repos: opts.repos ?? [{ github: { owner: "acme", name: "widgets" } }],
    logger: silentLogger,
    env: {
      githubToken: undefined,
      anthropicApiKey: undefined,
      runtime: "cli",
      live: false,
      port: 5000,
      host: "0.0.0.0",
      repos: [],
      dataDir: opts.dataDir,
      auth,
    },
    config: {
      trigger: { mode: "poll", pollIntervalMs: 60000 },
    },
    queue: { activeCount: () => 0 },
    clientFor: () => null,
  } as unknown as WarrenApp;
  return { app, history };
}
