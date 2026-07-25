import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectedMcpServerDef, TriggerResult } from "@herdctl/core";
import { createReviewPipeline } from "../src/review/pipeline.js";
import { createReviewTargetProvider } from "../src/review/target.js";
import { fingerprint } from "../src/review/fingerprint.js";
import type { FleetWrapper } from "../src/herd/fleet.js";
import type { LocalGitTarget, Logger, ReviewEvent, TokenUsage, WarrenConfig } from "../src/types.js";
import { targetKey } from "../src/types.js";
import { runGit } from "../src/review/target.js";
import { createReviewHistoryStore } from "../src/state/history.js";
import type { RateLimiter } from "../src/review/limits.js";

// ─────────────────────────── Fixtures ───────────────────────────

let repoDir: string;
let dataDir: string;

async function git(args: string[]): Promise<string> {
  return runGit(args, { cwd: repoDir });
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "warren-pipe-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "warren-pipe-data-"));
  await runGit(["init", "--quiet", repoDir]);
  await git(["config", "user.email", "test@warren.local"]);
  await git(["config", "user.name", "Warren Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["checkout", "-q", "-b", "main"]);
  await writeFile(join(repoDir, "a.txt"), "line1\nline2\nline3\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-q", "-m", "base"]);
  await git(["checkout", "-q", "-b", "pr/seeded-issues"]);
  await writeFile(join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src/new.ts"), "export const x = 1;\n");
  await git(["add", "a.txt", "src/new.ts"]);
  await git(["commit", "-q", "-m", "head"]);
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const target = (): LocalGitTarget => ({
  kind: "local-git",
  repoDir,
  baseRef: "main",
  headRef: "pr/seeded-issues",
  label: "local:seeded-issues",
});

const HIGH = {
  path: "src/new.ts",
  line: 1,
  side: "RIGHT" as const,
  severity: "high",
  category: "bug",
  title: "Exported constant is never validated",
  body: "The exported `x` is used downstream without a bounds check.",
};
// A real-severity finding that the verify pass will REFUTE (keep:false) → gate drops it.
const MED = {
  path: "a.txt",
  line: 2,
  side: "RIGHT" as const,
  severity: "medium",
  category: "correctness",
  title: "CHANGED may not be reachable",
  body: "Speculative concern the verifier disproves.",
};
const LOW = {
  path: "a.txt",
  line: 2,
  side: "RIGHT" as const,
  severity: "low",
  category: "style",
  title: "Prefer a clearer marker than CHANGED",
  body: "Minor readability nit on the placeholder line.",
};

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeConfig(): WarrenConfig {
  return {
    profile: "chill",
    minSeverity: "medium",
    trigger: { mode: "poll", pollIntervalMs: 60000 },
    autoReview: {
      enabled: true, drafts: false, baseBranches: ["main"], authors: [],
      denyAuthors: [], skipReleasePrs: true,
      releaseTitlePatterns: [], releaseBranchPatterns: [], releaseAuthors: [],
      skipLabels: ["warren:skip"], onlyLabels: [], skipTitlePatterns: [], skipBranchPatterns: [],
    },
    review: { effort: "normal", maxFiles: 0, maxTokens: 0 },
    pathFilters: [],
    pathInstructions: [],
    walkthrough: { sequenceDiagrams: false, poem: false },
    commandsAllowed: ["review"],
    models: { triage: "haiku", review: "opus", verify: "haiku" },
    resolveOnFix: true,
    live: false,
    repos: [],
    concurrency: 1,
  };
}

// ─────────────────────────── Fake fleet ───────────────────────────
//
// The fake trigger synthesizes each agent turn by invoking the INJECTED github_pr
// tool handlers directly — exactly the seam the real agent uses — so the pipeline
// genuinely reads findings from the MCP collector (no real FleetManager/Claude).

async function callTool(
  servers: Record<string, InjectedMcpServerDef> | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const tool = servers?.github_pr?.tools.find((t) => t.name === name);
  if (tool) await tool.handler(args as never);
}

/** Emit assistant TEXT the way the real runtime does — the verify pass reads this. */
function emitText(opts: { onMessage?: (m: never) => void | Promise<void> }, text: string): void {
  opts.onMessage?.({ type: "assistant", message: { content: [{ type: "text", text }] } } as never);
}

function fakeFleet(): FleetWrapper {
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
          summary: "Three issues found.",
          walkthrough: "Walkthrough: changed a.txt and added src/new.ts.",
          findings: [HIGH, MED, LOW],
        });
      } else if (agentName.startsWith("verify-")) {
        // Verify now returns a JSON verdict ARRAY as free-form TEXT (no MCP tool call):
        // keep the HIGH finding, explicitly refute the MED one. Wrapped in prose + a
        // markdown fence to exercise the robust extractor.
        const verdicts = [
          { id: fingerprint(HIGH), keep: true, confidence: 0.9, reason: "Confirmed: no bounds check." },
          { id: fingerprint(MED), keep: false, confidence: 0.1, reason: "Refuted: line is reachable." },
        ];
        emitText(opts, `Here are my verdicts:\n\`\`\`json\n${JSON.stringify(verdicts)}\n\`\`\`\n`);
      }
      return ok(agentName);
    },
    async cancel() {},
    async stop() {},
  };
}

// ─────────────────────────── Test ───────────────────────────

describe("createReviewPipeline (offline, fake fleet + local-git)", () => {
  it("runs a review, gates a below-threshold finding, and writes a local report", async () => {
    const provider = createReviewTargetProvider({ dataDir, pathFilters: [] });
    const pipeline = createReviewPipeline({
      provider,
      fleet: fakeFleet(),
      state: (await import("../src/state/store.js")).createReviewStateStore(dataDir),
      config: () => makeConfig(),
      dataDir,
      logger: silentLogger,
    });

    const event: ReviewEvent = {
      target: target(),
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    };
    const result = await pipeline.run(event);

    // Produced a ReviewResult with the review posted.
    expect(result.posted).toBe(true);
    expect(result.stats.findingsRaw).toBe(3);

    // The HIGH finding SURVIVED verify (via a JSON-text verdict) and was posted.
    expect(result.stats.findingsPosted).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].verified).toBe(true);
    expect(result.findings[0].confidence).toBeCloseTo(0.9);
    // Verify explicitly REFUTED the MED finding (keep:false) → dropped by the gate.
    expect(result.findings.some((f) => f.title === MED.title)).toBe(false);
    // The below-threshold LOW finding was dropped on severity.
    expect(result.findings.some((f) => f.title === LOW.title)).toBe(false);

    // A local markdown report was written and contains the surviving finding.
    const reviewsDir = join(dataDir, "reviews");
    const files = await readdir(reviewsDir);
    expect(files.length).toBeGreaterThan(0);
    const report = await readFile(join(reviewsDir, files[0]), "utf8");
    expect(report).toContain("## Findings (1)");
    expect(report).toContain(HIGH.title);
    expect(report).not.toContain(MED.title);
    expect(report).not.toContain(LOW.title);
    expect(report).toContain(result.findings[0].fingerprint);
  });
});

// ─────────────────────────── Recall + coverage + walkthrough ───────────────────────────
//
// A configurable fake fleet: the reviewer submits `review`, the verifier returns
// `verdicts` (as JSON text). Lets each test drive a specific findings/verdict shape.

function fakeFleetWith(
  review: { summary: string; walkthrough?: string; findings: unknown[] },
  verdicts: Array<{ id: string; keep: boolean; confidence: number }>,
): FleetWrapper {
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
        await callTool(opts.injectedMcpServers, "submit_review", review as Record<string, unknown>);
      } else if (agentName.startsWith("verify-")) {
        emitText(opts, JSON.stringify(verdicts));
      }
      return ok(agentName);
    },
    async cancel() {},
    async stop() {},
  };
}

describe("recall + coverage + walkthrough (default low config)", () => {
  const LOW_RACE = {
    path: "src/new.ts",
    line: 1,
    side: "RIGHT" as const,
    severity: "low",
    category: "correctness",
    title: "Narrow last-writer-wins race on the cached value",
    body: "Two concurrent callers can clobber the cached export; low impact but real.",
  };

  async function freshDeps() {
    const dd = await mkdtemp(join(tmpdir(), "warren-pipe-data-"));
    const state = (await import("../src/state/store.js")).createReviewStateStore(dd);
    return { dd, state };
  }

  const lowTarget = (): LocalGitTarget => ({ ...target(), label: "local:low" });
  const cleanTarget = (): LocalGitTarget => ({ ...target(), label: "local:clean" });

  it("surfaces a VERIFIED low finding at the default (low) gate, with a populated walkthrough + coverage", async () => {
    const { dd, state } = await freshDeps();
    const provider = createReviewTargetProvider({ dataDir: dd, pathFilters: [] });
    const cfg = { ...makeConfig(), minSeverity: "low" as const };
    const pipeline = createReviewPipeline({
      provider,
      fleet: fakeFleetWith(
        { summary: "Caches derived per-session facts.", findings: [LOW_RACE] },
        [{ id: fingerprint(LOW_RACE as never), keep: true, confidence: 0.8 }],
      ),
      state,
      config: () => cfg,
      dataDir: dd,
      logger: silentLogger,
    });
    const result = await pipeline.run({
      target: lowTarget(),
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    });

    // The low finding was NOT gated out at default config.
    expect(result.stats.findingsPosted).toBe(1);
    expect(result.findings[0].severity).toBe("low");
    expect(result.findings[0].verified).toBe(true);

    // Walkthrough is non-empty and carries the coverage line.
    expect(result.walkthrough.trim().length).toBeGreaterThan(0);
    expect(result.stats.coverage).toMatch(/Reviewed \d+ changed files? \(\d+ hunks?\)/);
    expect(result.walkthrough).toContain(result.stats.coverage);
    await rm(dd, { recursive: true, force: true });
  });

  it("still writes a non-empty walkthrough + coverage line on a 0-finding review", async () => {
    const { dd, state } = await freshDeps();
    const provider = createReviewTargetProvider({ dataDir: dd, pathFilters: [] });
    const pipeline = createReviewPipeline({
      provider,
      fleet: fakeFleetWith(
        { summary: "Read both changed files; confirmed the invariant holds. No issues.", findings: [] },
        [],
      ),
      state,
      config: () => ({ ...makeConfig(), minSeverity: "low" as const }),
      dataDir: dd,
      logger: silentLogger,
    });
    const result = await pipeline.run({
      target: cleanTarget(),
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    });

    expect(result.stats.findingsPosted).toBe(0);
    expect(result.posted).toBe(false);
    // Even with 0 findings the walkthrough is non-empty and coverage reads "looked, found nothing".
    expect(result.walkthrough.trim().length).toBeGreaterThan(0);
    expect(result.stats.coverage).toContain("0 findings");
    expect(result.walkthrough).toContain(result.stats.coverage);

    // The local report renders a Walkthrough section (never blank).
    const files = await readdir(join(dd, "reviews"));
    const report = await readFile(join(dd, "reviews", files[0]), "utf8");
    expect(report).toContain("## Walkthrough");
    expect(report).toContain("0 findings");
    await rm(dd, { recursive: true, force: true });
  });

  it("persists the reviewer herdctl session id so @warren ask can resume it", async () => {
    const { dd, state } = await freshDeps();
    const provider = createReviewTargetProvider({ dataDir: dd, pathFilters: [] });
    const t: LocalGitTarget = { ...target(), label: "local:sesscap" };
    const pipeline = createReviewPipeline({
      provider,
      // Clean review (no findings) → only the reviewer turn runs → its session is sess-1.
      fleet: fakeFleetWith({ summary: "No issues found.", findings: [] }, []),
      state,
      config: () => ({ ...makeConfig(), minSeverity: "low" as const }),
      dataDir: dd,
      logger: silentLogger,
    });
    const result = await pipeline.run({
      target: t,
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    });

    expect(result.sessionId).toBe("sess-1");
    const st = await state.getPrState(targetKey(t));
    expect(st.reviewerSessionId).toBe("sess-1");
    await rm(dd, { recursive: true, force: true });
  });

  it("does not duplicate the summary prose into the walkthrough (warren#1)", async () => {
    const { dd, state } = await freshDeps();
    const provider = createReviewTargetProvider({ dataDir: dd, pathFilters: [] });
    const summary = "Read both changed files; confirmed the invariant holds. No issues.";
    const pipeline = createReviewPipeline({
      provider,
      // Agent supplies a summary but NO distinct walkthrough — the case that used to
      // copy the summary into the walkthrough and render it twice.
      fleet: fakeFleetWith({ summary, findings: [] }, []),
      state,
      config: () => ({ ...makeConfig(), minSeverity: "low" as const }),
      dataDir: dd,
      logger: silentLogger,
    });
    const result = await pipeline.run({
      target: cleanTarget(),
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    });

    // Walkthrough is still non-empty (coverage line) but is NOT the summary prose.
    expect(result.walkthrough.trim().length).toBeGreaterThan(0);
    expect(result.walkthrough).not.toContain(summary);
    // The rendered report keeps both headers, but the summary paragraph appears once.
    const files = await readdir(join(dd, "reviews"));
    const report = await readFile(join(dd, "reviews", files[0]), "utf8");
    expect(report).toContain("## Summary");
    expect(report).toContain("## Walkthrough");
    expect(report.split(summary).length - 1).toBe(1);
    await rm(dd, { recursive: true, force: true });
  });
});

// ─────────────────────────── Usage + rate-limit integration ───────────────────────────
//
// The same HIGH/MED/LOW fake as the first block, but every agent turn ALSO emits a
// `result` SDK message carrying a usage block — exactly the seam runAgentTurn reads —
// so the pipeline aggregates REAL per-pass token usage and prices it.

const PER_TURN_USAGE = { input_tokens: 1000, output_tokens: 500 };

/** Fake fleet whose reviewer + verify turns each emit a `result` usage block. */
function fakeFleetWithUsage(): FleetWrapper {
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
          summary: "Three issues found.",
          walkthrough: "Walkthrough: changed a.txt and added src/new.ts.",
          findings: [HIGH, MED, LOW],
        });
      } else if (agentName.startsWith("verify-")) {
        const verdicts = [
          { id: fingerprint(HIGH), keep: true, confidence: 0.9, reason: "Confirmed." },
          { id: fingerprint(MED), keep: false, confidence: 0.1, reason: "Refuted." },
        ];
        emitText(opts, `\`\`\`json\n${JSON.stringify(verdicts)}\n\`\`\``);
      }
      // Every turn reports its token usage via a `result` message.
      opts.onMessage?.({ type: "result", usage: PER_TURN_USAGE } as never);
      return ok(agentName);
    },
    async cancel() {},
    async stop() {},
  };
}

describe("review usage accounting + rate limiting", () => {
  async function freshDeps() {
    const dd = await mkdtemp(join(tmpdir(), "warren-pipe-data-"));
    const state = (await import("../src/state/store.js")).createReviewStateStore(dd);
    return { dd, state };
  }

  it("aggregates token usage + notional cost onto stats and the history record", async () => {
    const { dd, state } = await freshDeps();
    const provider = createReviewTargetProvider({ dataDir: dd, pathFilters: [] });
    const history = createReviewHistoryStore(dd);
    const pipeline = createReviewPipeline({
      provider,
      fleet: fakeFleetWithUsage(),
      state,
      history,
      config: () => makeConfig(),
      dataDir: dd,
      logger: silentLogger,
    });

    const t: LocalGitTarget = { ...target(), label: "local:usage" };
    const result = await pipeline.run({
      target: t,
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    });

    // Normal effort runs reviewer + verify → two turns each reporting PER_TURN_USAGE.
    expect(result.stats.usage).toBeDefined();
    expect(result.stats.usage?.inputTokens).toBe(2 * PER_TURN_USAGE.input_tokens);
    expect(result.stats.usage?.outputTokens).toBe(2 * PER_TURN_USAGE.output_tokens);
    // Notional cost priced at the review model (opus) — strictly positive.
    expect(result.stats.costUsd).toBeGreaterThan(0);

    // The appended history record carries the same usage + cost.
    const all = await history.all();
    expect(all).toHaveLength(1);
    expect(all[0].usage).toEqual(result.stats.usage);
    expect(all[0].costUsd).toBe(result.stats.costUsd);
    expect(all[0].costUsd).toBeGreaterThan(0);

    await rm(dd, { recursive: true, force: true });
  });

  it("a rate-limiter DENY is a no-op: no state advance, no history append, no agent run", async () => {
    const { dd, state } = await freshDeps();
    const provider = createReviewTargetProvider({ dataDir: dd, pathFilters: [] });
    const history = createReviewHistoryStore(dd);

    // A fleet that must never be triggered — admission gates before any token is spent.
    const guardFleet: FleetWrapper = {
      fleet: {} as never,
      async addReviewAgent() {
        throw new Error("addReviewAgent must not run when the review is rate-limited");
      },
      async trigger() {
        throw new Error("trigger must not run when the review is rate-limited");
      },
      async cancel() {},
      async stop() {},
    };

    let admitCalls = 0;
    const denyingLimiter: RateLimiter = {
      async tryAdmit() {
        admitCalls += 1;
        return { admitted: false, reason: "reviews/hour 5 ≥ limit 5" };
      },
      async snapshot() {
        throw new Error("snapshot not used in this test");
      },
    };

    const t: LocalGitTarget = { ...target(), label: "local:denied" };
    const key = targetKey(t);
    const pipeline = createReviewPipeline({
      provider,
      fleet: guardFleet,
      state,
      history,
      rateLimiter: denyingLimiter,
      config: () => makeConfig(),
      dataDir: dd,
      logger: silentLogger,
    });

    const result = await pipeline.run({
      target: t,
      reason: "manual",
      full: true,
      receivedAt: new Date().toISOString(),
    });

    // The limiter was consulted and the review was a no-op.
    expect(admitCalls).toBe(1);
    expect(result.posted).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.stats.findingsRaw).toBe(0);

    // lastReviewedSha was NOT advanced (so the next poll re-attempts once the window frees).
    const st = await state.getPrState(key);
    expect(st.lastReviewedSha ?? "").toBe("");

    // Nothing was appended to history.
    expect(await history.all()).toEqual([]);

    await rm(dd, { recursive: true, force: true });
  });
});
