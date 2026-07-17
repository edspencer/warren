// Resolve-on-fix (SPEC §3.8, M2): when Warren re-reviews a PR and a previously-posted
// finding is no longer detected (author fixed it), the corresponding GitHub review
// thread is auto-resolved. Driven entirely with fakes — no real GitHub, no real Claude.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InjectedMcpServerDef, TriggerResult } from "@herdctl/core";
import { createReviewPipeline } from "../src/review/pipeline.js";
import { encodeFindingMarker, fingerprint } from "../src/review/fingerprint.js";
import type { GitHubClient, PrFile, ReviewThread, WriteOutcome } from "../src/github/index.js";
import type { FleetWrapper } from "../src/herd/fleet.js";
import type { ReviewTargetProvider, MaterializedTarget } from "../src/review/target.js";
import type { GithubPrTarget, Logger, ReviewEvent, WarrenConfig } from "../src/types.js";
import { createReviewStateStore } from "../src/state/store.js";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const FINDING = {
  path: "src/a.ts",
  line: 3,
  side: "RIGHT" as const,
  severity: "high" as const,
  category: "bug" as const,
  title: "Unvalidated input reaches the sink",
  body: "The value flows to the sink without a bounds check.",
};
const FP = fingerprint(FINDING);

const target = (): GithubPrTarget => ({
  kind: "github-pr",
  repo: { owner: "acme", name: "widget" },
  prNumber: 7,
  headSha: "head1",
  baseSha: "base1",
  baseRef: "main",
});

function makeConfig(over: Partial<WarrenConfig> = {}): WarrenConfig {
  return {
    profile: "chill",
    minSeverity: "low",
    trigger: { mode: "poll", pollIntervalMs: 60000 },
    autoReview: { enabled: true, drafts: false, baseBranches: ["main"], authors: [] },
    pathFilters: [],
    pathInstructions: [],
    walkthrough: { sequenceDiagrams: false, poem: false },
    commandsAllowed: ["review"],
    models: { triage: "haiku", review: "opus", verify: "haiku" },
    resolveOnFix: true,
    live: false,
    repos: [],
    concurrency: 1,
    ...over,
  };
}

// ─────────────────────────── Fake target provider ───────────────────────────
// Returns a materialized github-pr target with a controlled changed-file list — no
// clone/network. `diff` is empty (findings still fingerprint + gate; the sink simply
// drops off-diff comments, which is irrelevant to resolve-on-fix).

function fakeProvider(files: string[], headSha: string): ReviewTargetProvider {
  const mt: MaterializedTarget = {
    kind: "github-pr",
    headSha,
    baseSha: "base1",
    diff: "",
    files: files.map(
      (path): PrFile => ({ path, status: "modified", additions: 1, deletions: 0, patch: "" }),
    ),
    checkoutDir: "/tmp/fake-checkout",
    context: { title: "t", body: "b", author: "a" },
    async readFile() {
      return "";
    },
    async dispose() {},
  };
  return { async materialize() { return mt; } };
}

// ─────────────────────────── Fake fleet ───────────────────────────
// Reviewer submits the given findings via the injected github_pr MCP; verifier keeps
// every candidate (JSON verdict text). Mirrors test/pipeline.test.ts's fakeFleet.

async function callTool(
  servers: Record<string, InjectedMcpServerDef> | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const tool = servers?.github_pr?.tools.find((t) => t.name === name);
  if (tool) await tool.handler(args as never);
}

function fakeFleet(findings: unknown[]): FleetWrapper {
  let n = 0;
  const ok = (agentName: string): TriggerResult => ({
    jobId: `job-${++n}`,
    agentName,
    scheduleName: null,
    startedAt: new Date().toISOString(),
    success: true,
    sessionId: `sess-${n}`,
  });
  return {
    fleet: {} as never,
    async addReviewAgent() {
      return { name: "fake" } as never;
    },
    async trigger(agentName, opts) {
      if (agentName.startsWith("reviewer-")) {
        await callTool(opts.injectedMcpServers, "submit_review", {
          summary: "Reviewed.",
          findings,
        });
      } else if (agentName.startsWith("verify-")) {
        const verdicts = (findings as Array<Record<string, unknown>>).map((f) => ({
          id: fingerprint(f as never),
          keep: true,
          confidence: 0.9,
        }));
        opts.onMessage?.({
          type: "assistant",
          message: { content: [{ type: "text", text: JSON.stringify(verdicts) }] },
        } as never);
      }
      return ok(agentName);
    },
    async cancel() {},
    async stop() {},
  };
}

// ─────────────────────────── Fake GitHub client (spy) ───────────────────────────
// Reads return the seeded review threads; writes record their intent and echo the
// client's dry-run flag. Only the methods the pipeline touches are implemented.

class FakeClient {
  readonly resolveCalls: string[] = [];
  createReviews = 0;
  constructor(
    private readonly threads: ReviewThread[],
    private readonly dryRun: boolean,
  ) {}

  async getPr() {
    return { title: "t", body: "b", baseSha: "base1", headSha: "head1" } as never;
  }
  async listFiles(): Promise<PrFile[]> {
    return [];
  }
  async listReviewThreads(): Promise<ReviewThread[]> {
    return this.threads;
  }
  async createReview(): Promise<WriteOutcome> {
    this.createReviews += 1;
    return { dryRun: this.dryRun, ref: 1 };
  }
  async upsertStickyComment(): Promise<WriteOutcome> {
    return { dryRun: this.dryRun, ref: 2 };
  }
  async resolveThread(_repo: unknown, threadId: string): Promise<WriteOutcome> {
    this.resolveCalls.push(threadId);
    return { dryRun: this.dryRun, ref: threadId };
  }
}

function thread(id: string, fp: string, path: string, isResolved = false): ReviewThread {
  return {
    id,
    isResolved,
    isOutdated: false,
    path,
    firstCommentDatabaseId: 100,
    firstCommentBody: `**HIGH · bug** — a finding\n\n${encodeFindingMarker(fp)}`,
  };
}

// ─────────────────────────── Harness ───────────────────────────

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-rof-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function event(full: boolean): ReviewEvent {
  return { target: target(), reason: full ? "manual" : "new_head", full, receivedAt: new Date().toISOString() };
}

/** Seed state as if run #1 had already posted `FINDING` (fingerprint FP). */
async function seedPosted(): Promise<ReturnType<typeof createReviewStateStore>> {
  const state = createReviewStateStore(dataDir);
  await state.setPrState("github:acme/widget#7", (s) => ({
    ...s,
    lastReviewedSha: "head0",
    postedFingerprints: [FP],
  }));
  return state;
}

function runPipeline(opts: {
  state: ReturnType<typeof createReviewStateStore>;
  client: FakeClient;
  findings: unknown[];
  files: string[];
  cfg?: WarrenConfig;
}) {
  const pipeline = createReviewPipeline({
    provider: fakeProvider(opts.files, "head1"),
    fleet: fakeFleet(opts.findings),
    state: opts.state,
    config: () => opts.cfg ?? makeConfig(),
    clientFor: () => opts.client as unknown as GitHubClient,
    dataDir,
    logger: silentLogger,
  });
  return pipeline.run(event(false));
}

// ─────────────────────────── Tests ───────────────────────────

describe("resolve-on-fix", () => {
  it("(a) resolves the thread of a finding present in review #1 but absent in #2", async () => {
    const state = await seedPosted();
    const client = new FakeClient([thread("PRRT_1", FP, "src/a.ts")], /*dryRun*/ false);

    // Re-review detects NOTHING (author fixed the finding).
    const result = await runPipeline({ state, client, findings: [], files: ["src/a.ts"] });

    expect(result.posted).toBe(false);
    // Exactly the fixed finding's thread was resolved, by node id.
    expect(client.resolveCalls).toEqual(["PRRT_1"]);
    // The resolved fingerprint is pruned from state.
    const st = await state.getPrState("github:acme/widget#7");
    expect(st.postedFingerprints).not.toContain(FP);
  });

  it("(b) does NOT resolve a finding that is still detected on re-review", async () => {
    const state = await seedPosted();
    const client = new FakeClient([thread("PRRT_1", FP, "src/a.ts")], false);

    // Re-review still detects the same finding (raw), even though the gate dedups it.
    await runPipeline({ state, client, findings: [FINDING], files: ["src/a.ts"] });

    expect(client.resolveCalls).toEqual([]);
    const st = await state.getPrState("github:acme/widget#7");
    expect(st.postedFingerprints).toContain(FP);
  });

  it("(c) dry-run CAPTURES the resolve (client returns dryRun; still pruned)", async () => {
    const state = await seedPosted();
    const client = new FakeClient([thread("PRRT_1", FP, "src/a.ts")], /*dryRun*/ true);

    await runPipeline({ state, client, findings: [], files: ["src/a.ts"] });

    // The resolve intent was routed through the client exactly like a live resolve.
    expect(client.resolveCalls).toEqual(["PRRT_1"]);
    const st = await state.getPrState("github:acme/widget#7");
    expect(st.postedFingerprints).not.toContain(FP);
  });

  it("(d) resolveOnFix:false disables resolving entirely", async () => {
    const state = await seedPosted();
    const client = new FakeClient([thread("PRRT_1", FP, "src/a.ts")], false);

    await runPipeline({
      state,
      client,
      findings: [],
      files: ["src/a.ts"],
      cfg: makeConfig({ resolveOnFix: false }),
    });

    expect(client.resolveCalls).toEqual([]);
    const st = await state.getPrState("github:acme/widget#7");
    expect(st.postedFingerprints).toContain(FP);
  });

  it("does NOT resolve a disappeared finding on a file not re-reviewed this run", async () => {
    const state = await seedPosted();
    // The thread is anchored to src/other.ts, which is NOT in this run's changed files —
    // an incremental re-review simply didn't look at it, so it must stay open.
    const client = new FakeClient([thread("PRRT_1", FP, "src/other.ts")], false);

    await runPipeline({ state, client, findings: [], files: ["src/a.ts"] });

    expect(client.resolveCalls).toEqual([]);
    const st = await state.getPrState("github:acme/widget#7");
    expect(st.postedFingerprints).toContain(FP);
  });
});
