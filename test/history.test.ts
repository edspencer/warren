import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReviewHistoryStore,
  recordFromResult,
  type ReviewHistoryStore,
} from "../src/state/history.js";
import type { Finding, ReviewResult, ReviewTarget } from "../src/types.js";

// ─────────────────────────── Fixtures ───────────────────────────

let dataDir: string;
let store: ReviewHistoryStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "warren-history-"));
  store = createReviewHistoryStore(dataDir);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function finding(over: Partial<Finding> = {}): Finding {
  return {
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "high",
    category: "bug",
    title: "Possible null deref",
    body: "…",
    confidence: 0.9,
    fingerprint: "fp-" + Math.random().toString(36).slice(2),
    verified: true,
    ...over,
  };
}

function ghResult(over: {
  owner?: string;
  name?: string;
  pr?: number;
  headSha?: string;
  findings?: Finding[];
  posted?: number;
} = {}): ReviewResult {
  const target: ReviewTarget = {
    kind: "github-pr",
    repo: { owner: over.owner ?? "acme", name: over.name ?? "widgets" },
    prNumber: over.pr ?? 7,
    headSha: over.headSha ?? "abc1234",
    baseSha: "base000",
    baseRef: "main",
  };
  const findings = over.findings ?? [finding()];
  return {
    target,
    summary: "A summary.",
    walkthrough: "A walkthrough.",
    findings,
    stats: {
      filesReviewed: 3,
      hunksReviewed: 5,
      findingsRaw: findings.length + 1,
      findingsVerified: findings.length,
      findingsPosted: over.posted ?? findings.length,
      coverage: "Reviewed 3 files.",
      durationMs: 4200,
      triageModel: "t",
      reviewModel: "claude-opus-4",
      verifyModel: "v",
    },
    posted: findings.length > 0,
  };
}

function localResult(label: string): ReviewResult {
  const target: ReviewTarget = {
    kind: "local-git",
    repoDir: "/tmp/repo",
    baseRef: "main",
    headRef: "pr/x",
    label,
  };
  return {
    target,
    summary: "local",
    walkthrough: "local wt",
    findings: [],
    stats: {
      filesReviewed: 1,
      hunksReviewed: 1,
      findingsRaw: 0,
      findingsVerified: 0,
      findingsPosted: 0,
      coverage: "c",
      durationMs: 100,
      triageModel: "t",
      reviewModel: "m",
      verifyModel: "v",
    },
    posted: false,
  };
}

// ─────────────────────────── Tests ───────────────────────────

describe("recordFromResult", () => {
  it("maps a github-pr result into the persisted record shape", () => {
    const rec = recordFromResult(ghResult({ pr: 42, headSha: "deadbeef" }));
    expect(rec.kind).toBe("github-pr");
    expect(rec.repo).toBe("acme/widgets");
    expect(rec.prNumber).toBe(42);
    expect(rec.headSha).toBe("deadbeef");
    expect(rec.model).toBe("claude-opus-4");
    expect(rec.wallMs).toBe(4200);
    expect(rec.targetKey).toBe("github:acme/widgets#42");
    expect(rec.stats.findingsPosted).toBe(1);
    expect(rec.findings[0]).toMatchObject({
      severity: "high",
      category: "bug",
      title: "Possible null deref",
      path: "src/a.ts",
      line: 10,
      confidence: 0.9,
      verified: true,
    });
    // Strips internal fields (fingerprint/body/side) from persisted findings.
    expect(rec.findings[0]).not.toHaveProperty("fingerprint");
    expect(rec.findings[0]).not.toHaveProperty("body");
    expect(typeof rec.id).toBe("string");
    expect(rec.id.length).toBeGreaterThan(0);
  });

  it("uses the local label as repo and omits prNumber for local-git", () => {
    const rec = recordFromResult(localResult("local:x"));
    expect(rec.kind).toBe("local-git");
    expect(rec.repo).toBe("local:x");
    expect(rec.prNumber).toBeUndefined();
  });
});

describe("ReviewHistoryStore", () => {
  it("append + all returns newest-first", async () => {
    await store.append(ghResult({ pr: 1 }));
    await store.append(ghResult({ pr: 2 }));
    await store.append(ghResult({ pr: 3 }));
    const all = await store.all();
    expect(all.map((r) => r.prNumber)).toEqual([3, 2, 1]);
  });

  it("query filters by repo", async () => {
    await store.append(ghResult({ owner: "acme", name: "a", pr: 1 }));
    await store.append(ghResult({ owner: "acme", name: "b", pr: 2 }));
    const res = await store.query({ repo: "acme/b" });
    expect(res.total).toBe(1);
    expect(res.records[0].prNumber).toBe(2);
  });

  it("query filters by pr number", async () => {
    await store.append(ghResult({ pr: 10 }));
    await store.append(ghResult({ pr: 20 }));
    const res = await store.query({ pr: 20 });
    expect(res.total).toBe(1);
    expect(res.records[0].prNumber).toBe(20);
  });

  it("query paginates (limit/offset) over a newest-first list", async () => {
    for (let i = 1; i <= 5; i++) await store.append(ghResult({ pr: i }));
    const page = await store.query({ limit: 2, offset: 1 });
    expect(page.total).toBe(5); // total is pre-pagination
    // newest-first is [5,4,3,2,1]; offset 1 + limit 2 → [4,3]
    expect(page.records.map((r) => r.prNumber)).toEqual([4, 3]);
  });

  it("query summaries omit findings + walkthrough but keep findingsPosted", async () => {
    await store.append(ghResult({ posted: 2, findings: [finding(), finding()] }));
    const res = await store.query();
    const rec = res.records[0] as Record<string, unknown>;
    expect(rec).not.toHaveProperty("findings");
    expect(rec).not.toHaveProperty("walkthrough");
    expect(rec.findingsPosted).toBe(2);
  });

  it("get returns the full record (with findings + walkthrough) by id", async () => {
    const rec = await store.append(ghResult({ pr: 99 }));
    expect(rec).not.toBeNull();
    const got = await store.get(rec!.id);
    expect(got).not.toBeNull();
    expect(got!.prNumber).toBe(99);
    expect(got!.walkthrough).toBe("A walkthrough.");
    expect(Array.isArray(got!.findings)).toBe(true);
  });

  it("get returns null for an unknown id", async () => {
    await store.append(ghResult());
    expect(await store.get("nope")).toBeNull();
  });

  it("all() is empty before anything is appended", async () => {
    expect(await store.all()).toEqual([]);
    const res = await store.query();
    expect(res.total).toBe(0);
    expect(res.records).toEqual([]);
  });
});
