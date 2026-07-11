import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectedMcpServerDef, TriggerResult } from "@herdctl/core";
import { createReviewPipeline } from "../src/review/pipeline.js";
import { createReviewTargetProvider } from "../src/review/target.js";
import type { FleetWrapper } from "../src/herd/fleet.js";
import type { LocalGitTarget, Logger, ReviewEvent, WarrenConfig } from "../src/types.js";
import { runGit } from "../src/review/target.js";

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
  severity: "high",
  category: "bug",
  title: "Exported constant is never validated",
  body: "The exported `x` is used downstream without a bounds check.",
};
const LOW = {
  path: "a.txt",
  line: 2,
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
    autoReview: { enabled: true, drafts: false, baseBranches: ["main"] },
    pathFilters: [],
    pathInstructions: [],
    walkthrough: { sequenceDiagrams: false, poem: false },
    commandsAllowed: ["review"],
    models: { triage: "haiku", review: "opus", verify: "haiku" },
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
          summary: "Two issues found.",
          walkthrough: "Walkthrough: changed a.txt and added src/new.ts.",
          findings: [HIGH, LOW],
        });
      } else if (agentName.startsWith("verify-")) {
        // Survivor: the HIGH finding (same path/category/title → same fingerprint).
        await callTool(opts.injectedMcpServers, "submit_finding", { ...HIGH, confidence: 0.9 });
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
    expect(result.stats.findingsRaw).toBe(2);

    // Gate dropped the below-threshold (low) finding; kept the high one.
    expect(result.stats.findingsPosted).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].verified).toBe(true);
    expect(result.findings.some((f) => f.title === LOW.title)).toBe(false);

    // A local markdown report was written and contains the surviving finding.
    const reviewsDir = join(dataDir, "reviews");
    const files = await readdir(reviewsDir);
    expect(files.length).toBeGreaterThan(0);
    const report = await readFile(join(reviewsDir, files[0]), "utf8");
    expect(report).toContain(HIGH.title);
    expect(report).not.toContain(LOW.title);
    expect(report).toContain(result.findings[0].fingerprint);
  });
});
