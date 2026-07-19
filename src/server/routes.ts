// src/server/routes.ts — HTTP route registration wired to the WarrenApp container.
//
// Minimal, LAN-only, no auth (v1). NEVER leaks tokens: /status reports only presence
// booleans and non-secret config.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ZodError } from "zod";

import type { WarrenApp } from "../container.js";
import { parseWarrenConfig, resolveRepoConfig } from "../config/load.js";
import { WarrenConfigRawZ } from "../config/schema.js";
import type { HistoryRecord } from "../state/history.js";
import type { Severity, WarrenConfig } from "../types.js";
import {
  repoLabel,
  targetKey,
  type ReviewEvent,
  type ReviewTarget,
} from "../types.js";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "nit"];

/** Is this a "file not found" (ENOENT) error? */
function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

function zeroSeverityCounts(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
}

/** UTC day (YYYY-MM-DD) for a record's timestamp, for the time series. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Read-only, secret-free projection of a repo's effective config for the
 * dashboard (#19). Deliberately curated: exposes review model + the aggression /
 * filtering / auto-review knobs Warren actually applies, and NEVER any token or
 * the nested `repos` list.
 */
function effectiveConfigView(cfg: WarrenConfig) {
  return {
    profile: cfg.profile,
    minSeverity: cfg.minSeverity,
    model: cfg.models.review,
    models: cfg.models,
    autoReview: {
      enabled: cfg.autoReview.enabled,
      drafts: cfg.autoReview.drafts,
      baseBranches: cfg.autoReview.baseBranches,
      authors: cfg.autoReview.authors,
    },
    pathFilters: cfg.pathFilters,
    pathInstructions: cfg.pathInstructions,
    walkthrough: cfg.walkthrough,
    resolveOnFix: cfg.resolveOnFix,
  };
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
    githubAuthMode: app.githubAuthMode,
    ...(app.botLogin ? { botLogin: app.botLogin } : {}),
    webhookConfigured: app.webhookConfigured,
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

  // Flattened findings across all history records, newest-first, with the
  // review context needed to link each one back to its review (+ GitHub). Filters:
  //   ?severity=critical|high|medium|low|nit  ?repo=owner/name  ?verified=true|false
  server.get("/api/findings", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const severity = q.severity?.trim() || undefined;
    const repo = q.repo?.trim() || undefined;
    const verified =
      q.verified === "true" ? true : q.verified === "false" ? false : undefined;

    const records = await app.history.all(); // newest-first
    const findings = [];
    for (const r of records) {
      if (repo && r.repo !== repo) continue;
      for (const f of r.findings) {
        if (severity && f.severity !== severity) continue;
        if (verified !== undefined && f.verified !== verified) continue;
        findings.push({
          ...f,
          reviewId: r.id,
          repo: r.repo,
          kind: r.kind,
          prNumber: r.prNumber ?? null,
          headSha: r.headSha,
          timestamp: r.timestamp,
        });
      }
    }
    return { total: findings.length, findings };
  });

  // Per-repo detail: aggregate stats, review history, watched status, and the
  // effective (read-only) config Warren applies to it (#16 + #19). 404 when the
  // repo is neither watched nor present in history.
  server.get("/api/repos/:owner/:name", async (request, reply) => {
    const { owner, name } = request.params as { owner: string; name: string };
    const label = `${owner}/${name}`;

    const records = await app.history.all(); // newest-first
    const repoRecords = records.filter((r) => r.repo === label);

    const watchedRepo = app.repos.find(
      (rc) => rc.github?.owner === owner && rc.github?.name === name,
    );
    const watched = Boolean(watchedRepo);

    if (!watched && repoRecords.length === 0) {
      reply.code(404);
      return { error: "not found" };
    }

    const bySeverity = zeroSeverityCounts();
    let findingsPosted = 0;
    let totalWallMs = 0;
    for (const r of repoRecords) {
      findingsPosted += r.stats.findingsPosted;
      totalWallMs += r.wallMs;
      for (const f of r.findings) bySeverity[f.severity] += 1;
    }

    // Review summaries (findings + walkthrough stripped), newest-first.
    const reviews = repoRecords.map((r) => {
      const { findings: _f, walkthrough: _w, ...rest } = r;
      void _f;
      void _w;
      return { ...rest, findingsPosted: r.stats.findingsPosted };
    });

    const effective = watchedRepo
      ? resolveRepoConfig(app.config, watchedRepo)
      : app.config;

    return {
      repo: label,
      owner,
      name,
      watched,
      reviewCount: repoRecords.length,
      lastReviewAt: repoRecords[0]?.timestamp ?? null,
      firstReviewAt: repoRecords[repoRecords.length - 1]?.timestamp ?? null,
      totalFindings: {
        total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0),
        bySeverity,
      },
      findingsPosted,
      meanWallMs: repoRecords.length
        ? Math.round(totalWallMs / repoRecords.length)
        : 0,
      reviews,
      config: effectiveConfigView(effective),
    };
  });

  // ─────────────────────────── Config editing (#27) ───────────────────────────

  // Read the current server config. Guarded like the rest of `/api/*` (open in
  // `none` mode, bearer-required in `jwt` mode). The config is inherently
  // SECRET-FREE — secrets live in the process env (GITHUB_TOKEN, ANTHROPIC_API_KEY,
  // WARREN_JWT_SECRET), never in `.warren.yaml` (`trigger.secret_env` is only the
  // NAME of an env var). Returns the parsed structured config (snake_case, defaults
  // materialized — the shape the editor form round-trips) + the raw file text.
  server.get("/api/config", async () => {
    let text = "";
    let exists = false;
    try {
      text = await readFile(app.configPath, "utf8");
      exists = true;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    let structured;
    try {
      structured = WarrenConfigRawZ.parse(parseYaml(text) ?? {});
    } catch {
      // The on-disk config is malformed/invalid (bad YAML, a schema-invalid value,
      // or a torn/older file written outside the API). Fall back to a default
      // structured config while STILL returning the raw text (below), so the editor
      // loads and the operator can fix + re-save it — instead of 500ing the very
      // page meant to repair it. (PUT validates before writing, so the API never
      // creates such a file; external edits / partial writes can.)
      structured = WarrenConfigRawZ.parse({});
    }
    return {
      // snake_case config with every default applied (so newly-added schema knobs
      // appear in the editor form automatically).
      config: structured,
      // The on-disk text if the file exists, else a serialized default so the raw
      // editor is pre-populated with a valid starting point.
      raw: exists ? text : stringifyYaml(structured),
      exists,
      // Basename only — don't leak the absolute server path.
      path: path.basename(app.configPath),
      authMode: app.env.auth.mode,
      // Writes require jwt mode (see PUT below); the UI disables saving otherwise.
      editable: app.env.auth.mode === "jwt",
    };
  });

  // Write a new server config. HARD REQUIREMENT: `WARREN_AUTH_MODE=jwt` — in `jwt`
  // mode the auth hook has already enforced a valid bearer token for this `/api/*`
  // write (401 without); in `none` mode config writes are REFUSED (403) so an
  // unauthenticated LAN deploy can't let anyone rewrite the review policy.
  //
  // Body: `{ yaml }` (raw text, written verbatim so comments/formatting survive) OR
  // `{ config }` (structured snake_case, serialized to YAML). The submission is
  // validated with the Zod schema BEFORE anything is written — invalid config →
  // 400 with details, and the file on disk is left untouched. On success the file
  // is written and hot-reloaded in place (applies on the next poll / next review).
  server.put("/api/config", async (request, reply) => {
    if (app.env.auth.mode !== "jwt") {
      reply.code(403);
      return {
        error: "config editing is disabled unless WARREN_AUTH_MODE=jwt",
        code: "auth_mode_required",
      };
    }

    const body = (request.body ?? {}) as { yaml?: string; config?: unknown };
    let textToWrite: string;
    let toValidate: unknown;

    if (typeof body.yaml === "string") {
      textToWrite = body.yaml;
      try {
        toValidate = parseYaml(body.yaml) ?? {};
      } catch (err) {
        reply.code(400);
        return {
          error: "invalid YAML",
          details: [{ path: "", message: (err as Error).message }],
        };
      }
    } else if (body.config && typeof body.config === "object") {
      toValidate = body.config;
      textToWrite = stringifyYaml(body.config);
    } else {
      reply.code(400);
      return { error: "body must be { yaml: string } or { config: object }" };
    }

    try {
      parseWarrenConfig(toValidate); // Zod validate; throws ZodError on invalid.
    } catch (err) {
      if (err instanceof ZodError) {
        reply.code(400);
        return {
          error: "config validation failed",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        };
      }
      throw err;
    }

    await writeFile(app.configPath, textToWrite, "utf8");
    await app.reloadConfig();
    return { ok: true, applied: true, path: path.basename(app.configPath) };
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
