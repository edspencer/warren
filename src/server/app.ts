// src/server/app.ts — Fastify app factory.
//
// Wires the dashboard/API routes, the static dashboard SPA at `/`, and the auth
// layer (WARREN_AUTH_MODE = none | jwt; mirrors Paddock). Auth is registered
// BEFORE the routes so its onRequest hook guards every /api/* request.

import Fastify, { type FastifyInstance } from "fastify";

import type { WarrenApp } from "../container.js";
import { registerAuth } from "./auth.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { registerRoutes } from "./routes.js";

/** Build the Fastify server for a wired WarrenApp. Caller owns listen()/close(). */
export function createServer(app: WarrenApp): FastifyInstance {
  const server = Fastify({ logger: false });

  // Auth first: its onRequest hook guards /api/* (open in `none` mode).
  registerAuth(server, app.env.auth, app.logger);

  // Static dashboard shell (open — carries no data; the SPA fetches guarded APIs).
  server.get("/", async (_request, reply) => {
    reply.type("text/html").send(DASHBOARD_HTML);
  });

  // Webhook ingress (#32). Registered ONLY when a webhook secret is configured.
  // Encapsulated in a child context so its raw-body parser is scoped to this route
  // (the rest of the app keeps normal JSON parsing). The route is intentionally NOT
  // under /api/* — GitHub can't send a bearer; the HMAC signature IS the auth.
  // Signature is verified over the RAW body; a bad/missing signature → 401. Full
  // event → ReviewEvent delivery is a follow-up; a valid delivery is acknowledged.
  if (app.webhookConfigured) {
    server.register(async (instance) => {
      // Raw body is required for HMAC verification. Drop the inherited JSON parser
      // in THIS encapsulated scope (content-type parsers are per-scope) and capture
      // every body verbatim as a Buffer — a specific inherited `application/json`
      // parser would otherwise win over a `*` catch-all and hand us a parsed object.
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser(
        "*",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
      );
      instance.post("/webhook", async (request, reply) => {
        const raw = (request.body ?? Buffer.alloc(0)) as Buffer;
        const sigHeader = request.headers["x-hub-signature-256"];
        const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
        if (!app.verifyWebhook(raw, sig)) {
          reply.code(401);
          return { error: "invalid or missing webhook signature" };
        }
        // Signature valid. Delivery→review dispatch is a follow-up (poll still drives
        // reviews today); acknowledge so GitHub marks the delivery successful.
        reply.code(202);
        return { ok: true, delivered: false };
      });
    });
  }

  registerRoutes(server, app);

  // SPA fallback (#12): serve the same shell for every *client* route so a hard
  // refresh or a pasted deep link (e.g. /reviews/:id) hydrates the router instead
  // of 404ing. Only GET navigations that aren't API/probe/action paths get the
  // shell; unknown /api/* (and everything else) still returns a JSON 404. The
  // auth hook only guards /api/*, so these open shell routes never leak data.
  // NB: exact matches for the singular server routes (`/status`, `/review`) so
  // they don't shadow the client routes `/reviews` and `/reviews/:id`.
  const NON_SHELL_EXACT = new Set(["/healthz", "/status", "/review"]);
  const isServerPath = (path: string): boolean =>
    NON_SHELL_EXACT.has(path) || path === "/api" || path.startsWith("/api/");
  server.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0];
    if (request.method === "GET" && !isServerPath(path)) {
      reply.type("text/html").send(DASHBOARD_HTML);
      return;
    }
    reply.code(404).send({ error: "not found" });
  });

  return server;
}
