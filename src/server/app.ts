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
  return server;
}
