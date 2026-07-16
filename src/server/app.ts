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
