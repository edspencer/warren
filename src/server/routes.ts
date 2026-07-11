// src/server/routes.ts — HTTP route registration wired to the WarrenApp container.
//
// Minimal, LAN-only, no auth (v1). NEVER leaks tokens: /status reports only presence
// booleans and non-secret config.

import type { FastifyInstance } from "fastify";

import type { WarrenApp } from "../container.js";
import {
  repoLabel,
  targetKey,
  type ReviewEvent,
  type ReviewTarget,
} from "../types.js";

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
