// src/state/history.ts — append-only review-history store for the dashboard.
//
// Every completed review (github-pr AND local-git) is appended as ONE JSON line
// to ${dataDir}/history/reviews.jsonl. Records are immutable; queries read the
// file, parse each line, and filter/paginate in memory. This is intentionally
// simple and dependency-free — history volume for a self-hosted review bot is
// small (one record per PR review pass), so a linear scan is more than adequate
// and keeps the store trivially inspectable/greppable on disk.
//
// The write path is best-effort and NEVER throws into the pipeline: a review
// must still succeed even if history can't be persisted (the caller wraps
// append() but the store also swallows its own mkdir/write races defensively).

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import type { Finding, ReviewResult, ReviewTarget } from "../types.js";
import { repoLabel, targetKey } from "../types.js";

/** A single finding as persisted in history (dashboard-facing subset of Finding). */
export interface HistoryFinding {
  severity: Finding["severity"];
  category: Finding["category"];
  title: string;
  path: string;
  line: number;
  endLine?: number;
  confidence: number;
  verified: boolean;
}

/** Dashboard-facing stats subset (mirrors ReviewStats, without model bookkeeping). */
export interface HistoryStats {
  filesReviewed: number;
  hunksReviewed: number;
  findingsRaw: number;
  findingsVerified: number;
  findingsPosted: number;
  coverage: string;
}

/** One persisted review record (one JSONL line). */
export interface HistoryRecord {
  id: string;
  targetKey: string;
  kind: ReviewTarget["kind"];
  repo: string; // owner/name (github-pr) or local label (local-git)
  prNumber?: number; // github-pr only
  headSha: string;
  timestamp: string; // ISO
  model: string; // review model
  wallMs: number;
  stats: HistoryStats;
  summary: string;
  walkthrough: string;
  findings: HistoryFinding[];
}

/** Query filters for {@link ReviewHistoryStore.query}. */
export interface HistoryQuery {
  repo?: string; // exact repo label match (owner/name or local label)
  pr?: number; // github-pr number
  limit?: number; // default 50
  offset?: number; // default 0
}

/** Listing summary (findings + walkthrough stripped for cheap list responses). */
export type HistorySummary = Omit<HistoryRecord, "findings" | "walkthrough"> & {
  findingsPosted: number;
};

export interface HistoryQueryResult {
  total: number; // total matching records (pre-pagination)
  records: HistorySummary[];
}

export interface ReviewHistoryStore {
  /** Append a completed review. Best-effort; resolves even on write failure. */
  append(result: ReviewResult): Promise<HistoryRecord | null>;
  /** Paginated, newest-first query over summaries. */
  query(q?: HistoryQuery): Promise<HistoryQueryResult>;
  /** Full record (incl. findings + walkthrough) by id, or null if absent. */
  get(id: string): Promise<HistoryRecord | null>;
  /** All records, newest-first (used by aggregate endpoints). */
  all(): Promise<HistoryRecord[]>;
}

/** Build a HistoryRecord from a ReviewResult (pure; exported for tests). */
export function recordFromResult(result: ReviewResult, now = new Date()): HistoryRecord {
  const t = result.target;
  const s = result.stats;
  return {
    id: newId(now),
    targetKey: targetKey(t),
    kind: t.kind,
    repo: repoForTarget(t),
    ...(t.kind === "github-pr" ? { prNumber: t.prNumber } : {}),
    headSha: headShaForTarget(t),
    timestamp: now.toISOString(),
    model: s.reviewModel,
    wallMs: s.durationMs,
    stats: {
      filesReviewed: s.filesReviewed,
      hunksReviewed: s.hunksReviewed,
      findingsRaw: s.findingsRaw,
      findingsVerified: s.findingsVerified,
      findingsPosted: s.findingsPosted,
      coverage: s.coverage,
    },
    summary: result.summary,
    walkthrough: result.walkthrough,
    findings: result.findings.map(toHistoryFinding),
  };
}

function repoForTarget(t: ReviewTarget): string {
  return t.kind === "github-pr"
    ? repoLabel({ github: { owner: t.repo.owner, name: t.repo.name } })
    : t.label;
}

function headShaForTarget(t: ReviewTarget): string {
  return t.kind === "github-pr" ? t.headSha : "";
}

function toHistoryFinding(f: Finding): HistoryFinding {
  return {
    severity: f.severity,
    category: f.category,
    title: f.title,
    path: f.path,
    line: f.line,
    ...(f.endLine != null ? { endLine: f.endLine } : {}),
    confidence: f.confidence,
    verified: f.verified,
  };
}

function toSummary(r: HistoryRecord): HistorySummary {
  const { findings, walkthrough, ...rest } = r;
  void findings;
  void walkthrough;
  return { ...rest, findingsPosted: r.stats.findingsPosted };
}

/** Monotonic-ish, sortable id: <ms>-<rand>. */
function newId(now: Date): string {
  return `${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
}

class JsonlReviewHistoryStore implements ReviewHistoryStore {
  private readonly dir: string;
  private readonly file: string;
  /** Serialize appends so concurrent reviews never interleave partial lines. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "history");
    this.file = path.join(this.dir, "reviews.jsonl");
  }

  async append(result: ReviewResult): Promise<HistoryRecord | null> {
    const record = recordFromResult(result);
    const line = `${JSON.stringify(record)}\n`;
    const next = this.writeChain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.file, line, "utf8");
    });
    this.writeChain = next.catch(() => {});
    try {
      await next;
      return record;
    } catch {
      // Best-effort: never fail a review because history couldn't be written.
      return null;
    }
  }

  async all(): Promise<HistoryRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: HistoryRecord[] = [];
    for (const lineRaw of raw.split("\n")) {
      const line = lineRaw.trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as HistoryRecord);
      } catch {
        // Skip a torn/partial line rather than fail the whole query.
      }
    }
    // Newest-first.
    records.reverse();
    return records;
  }

  async query(q: HistoryQuery = {}): Promise<HistoryQueryResult> {
    const all = await this.all();
    const filtered = all.filter((r) => {
      if (q.repo && r.repo !== q.repo) return false;
      if (q.pr != null && r.prNumber !== q.pr) return false;
      return true;
    });
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.max(0, q.limit ?? 50);
    const page = filtered.slice(offset, offset + limit);
    return { total: filtered.length, records: page.map(toSummary) };
  }

  async get(id: string): Promise<HistoryRecord | null> {
    const all = await this.all();
    return all.find((r) => r.id === id) ?? null;
  }
}

/** Factory: JSONL-backed review-history store rooted at `dataDir`. */
export function createReviewHistoryStore(dataDir: string): ReviewHistoryStore {
  return new JsonlReviewHistoryStore(dataDir);
}
