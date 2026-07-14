// src/server/routes.ts — HTTP route registration wired to the WarrenApp container.
//
// Minimal, LAN-only, no auth (v1). NEVER leaks tokens: /status reports only presence
// booleans and non-secret config.

import type { FastifyInstance } from "fastify";

import type { WarrenApp } from "../container.js";
import type { HistoryRecord } from "../state/history.js";
import type { Severity } from "../types.js";
import {
  repoLabel,
  targetKey,
  type ReviewEvent,
  type ReviewTarget,
} from "../types.js";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "nit"];

function zeroSeverityCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
}

/** UTC day (YYYY-MM-DD) for a record's timestamp, for the time series. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

interface ManualReviewBody {
  kind?: string;
  repo?: string;
  prNumber?: number;
  full?: boolean;
  target?: ReviewTarget;
}

export function registerRoutes(server: FastifyInstance, app: WarrenApp): void {
  // Liveness.
  server.get("/healthz", async () => ({ ok: true }));

  // Read-only introspection. No secrets.
  server.get("/status", async () => ({
    live: app.env.live,
    mode: app.env.live ? "live" : "dry-run",
    runtime: app.env.runtime,
    dataDir: app.dataDir,
    trigger: {
      mode: app.config.trigger.mode,
      pollIntervalMs: app.config.trigger.pollIntervalMs,
    },
    queue: { active: app.queue.activeCount() },
    watchedRepos: app.repos.map(repoLabel),
    githubTokenConfigured: Boolean(app.env.githubToken),
  }));

  // ─────────────────────────── Dashboard API ───────────────────────────

  // Auth mode (UNAUTHENTICATED — the UI reads this to decide whether to ask for
  // a token). Reports the mode string only, never any secret.
  server.get("/api/auth-mode", async () => ({ mode: app.env.auth.mode }));

  // Aggregate metrics across all persisted reviews.
  server.get("/api/overview", async () => {
    const records = await app.history.all(); // newest-first
    const bySeverity = zeroSeverityCounts();
    const perDay = new Map<string, number>();
    let totalFindingsPosted = 0;
    let totalFindingsRaw = 0;
    let totalWallMs = 0;

    for (const r of records) {
      totalFindingsPosted += r.stats.findingsPosted;
      totalFindingsRaw += r.stats.findingsRaw;
      totalWallMs += r.wallMs;
      perDay.set(dayOf(r.timestamp), (perDay.get(dayOf(r.timestamp)) ?? 0) + 1);
      for (const f of r.findings) bySeverity[f.severity] += 1;
    }

    const reviewsOverTime = [...perDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return {
      totalReviews: records.length,
      totalFindings: {
        total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0),
        bySeverity,
      },
      findingsPosted: totalFindingsPosted,
      findingsRaw: totalFindingsRaw,
      reviewsOverTime,
      meanWallMs: records.length ? Math.round(totalWallMs / records.length) : 0,
      watchedRepos: app.repos.length,
      lastReviewAt: records[0]?.timestamp ?? null,
    };
  });

  // Watched repos + per-repo review count + last-review time.
  server.get("/api/repos", async () => {
    const records = await app.history.all();
    const stats = new Map<string, { reviewCount: number; lastReviewAt: string | null }>();
    for (const r of records) {
      const cur = stats.get(r.repo) ?? { reviewCount: 0, lastReviewAt: null };
      cur.reviewCount += 1;
      // records are newest-first, so the first seen is the latest.
      if (!cur.lastReviewAt) cur.lastReviewAt = r.timestamp;
      stats.set(r.repo, cur);
    }

    // Start from configured (watched) repos so a repo with 0 reviews still shows.
    const watched = app.repos.map(repoLabel);
    const seen = new Set<string>();
    const repos = [];
    for (const label of watched) {
      seen.add(label);
      const s = stats.get(label);
      repos.push({
        repo: label,
        watched: true,
        reviewCount: s?.reviewCount ?? 0,
        lastReviewAt: s?.lastReviewAt ?? null,
      });
    }
    // Include any repo that has history but isn't in the current watch list.
    for (const [label, s] of stats) {
      if (seen.has(label)) continue;
      repos.push({ repo: label, watched: false, reviewCount: s.reviewCount, lastReviewAt: s.lastReviewAt });
    }
    return { repos };
  });

  // Paginated recent review records (summary fields only).
  server.get("/api/reviews", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const repo = q.repo?.trim() || undefined;
    const pr = q.pr != null && q.pr !== "" ? Number(q.pr) : undefined;
    const limit = q.limit != null && q.limit !== "" ? Number(q.limit) : 50;
    const offset = q.offset != null && q.offset !== "" ? Number(q.offset) : 0;
    const result = await app.history.query({
      repo,
      pr: Number.isFinite(pr) ? pr : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return result;
  });

  // Full record (incl. findings + walkthrough) by id. 404 if absent.
  server.get("/api/reviews/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record: HistoryRecord | null = await app.history.get(id);
    if (!record) {
      reply.code(404);
      return { error: "not found" };
    }
    return record;
  });

  // Enqueue a manual review. Body is a full ReviewTarget, {target}, or {repo, prNumber}.
  server.post("/review", async (request, reply) => {
    const body = (request.body ?? {}) as ManualReviewBody;
    let target: ReviewTarget | undefined;

    if (body.target && typeof body.target === "object") {
      target = body.target;
    } else if (body.kind === "github-pr" || body.kind === "local-git") {
      target = body as unknown as ReviewTarget;
    } else if (body.repo && body.prNumber != null) {
      const [owner, name] = String(body.repo).split("/");
      if (!owner || !name) {
        reply.code(400);
        return { error: "repo must be 'owner/name'" };
      }
      const probe: ReviewTarget = {
        kind: "github-pr",
        repo: { owner, name },
        prNumber: Number(body.prNumber),
        headSha: "",
        baseSha: "",
        baseRef: "",
      };
      const client = app.clientFor(probe);
      if (!client) {
        reply.code(400);
        return { error: "no GitHub token configured; cannot resolve PR" };
      }
      const pr = await client.getPr({ owner, name }, Number(body.prNumber));
      target = {
        kind: "github-pr",
        repo: { owner, name },
        prNumber: pr.number,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        baseRef: pr.baseRef,
      };
    }

    if (!target) {
      reply.code(400);
      return { error: "body must be a ReviewTarget, {target}, or {repo, prNumber}" };
    }

    const event: ReviewEvent = {
      target,
      reason: "manual",
      full: Boolean(body.full),
      receivedAt: new Date().toISOString(),
    };
    app.queue.enqueue(event);
    reply.code(202);
    return { enqueued: true, key: targetKey(target) };
  });
}
