// src/server/app.ts — Fastify app factory. No auth in v1 (LAN-only).

import Fastify, { type FastifyInstance } from "fastify";

import type { WarrenApp } from "../container.js";
import { registerRoutes } from "./routes.js";

/** Build the Fastify server for a wired WarrenApp. Caller owns listen()/close(). */
export function createServer(app: WarrenApp): FastifyInstance {
  const server = Fastify({ logger: false });
  registerRoutes(server, app);
  return server;
}
