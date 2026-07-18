// test/fake-app.ts — a minimal WarrenApp good enough to exercise the HTTP layer
// (dashboard API + auth) via Fastify .inject(), without booting the fleet/trigger.

import { join } from "node:path";

import type { WarrenApp } from "../src/container.js";
import type { WarrenAuthConfig } from "../src/config/env.js";
import { defaultWarrenConfig, reloadWarrenConfigInto } from "../src/config/load.js";
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
  /** Per-repo config overrides merged into the fake server config's `repos`. */
  config?: Partial<WarrenApp["config"]>;
  /** Path the config-editing API (#27) reads/writes. Defaults under dataDir. */
  configPath?: string;
}

/** Build a fake WarrenApp with a real history store; other deps are stubs. */
export function makeFakeApp(opts: FakeAppOptions): {
  app: WarrenApp;
  history: ReviewHistoryStore;
} {
  const history = createReviewHistoryStore(opts.dataDir);
  const auth: WarrenAuthConfig = opts.auth ?? { mode: "none" };
  const repos = opts.repos ?? [{ github: { owner: "acme", name: "widgets" } }];
  // A real (all-defaults) WarrenConfig so resolveRepoConfig / effective-config
  // endpoints (#19) work; `repos` mirrors the watched list so per-repo overrides
  // resolve. Callers can pass `config` to override top-level fields.
  const config = { ...defaultWarrenConfig(), repos, ...(opts.config ?? {}) };
  const configPath = opts.configPath ?? join(opts.dataDir, ".warren.yaml");
  const env = {
    githubToken: undefined,
    anthropicApiKey: undefined,
    runtime: "cli",
    live: false,
    port: 5000,
    host: "0.0.0.0",
    repos: [],
    dataDir: opts.dataDir,
    auth,
  };
  const app = {
    history,
    dataDir: opts.dataDir,
    repos,
    logger: silentLogger,
    env,
    config,
    configPath,
    // Mirrors the real container: re-read the file and apply it in place onto
    // `config` (hot-reload), so config-editing endpoint tests exercise the true
    // read/write/validate/reload path against a temp file.
    reloadConfig: async () => {
      await reloadWarrenConfigInto(config, configPath, env as never, []);
    },
    queue: { activeCount: () => 0 },
    clientFor: () => null,
  } as unknown as WarrenApp;
  return { app, history };
}
