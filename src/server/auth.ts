// src/server/auth.ts — dashboard/API authentication (mirrors Paddock's auth.ts).
//
// Installer-configured via WARREN_AUTH_MODE (see config/env.ts):
//   - `none` — open access; every request is allowed (default).
//   - `jwt`  — require a signed `Authorization: Bearer <jwt>`; verify signature +
//              exp (and iss/aud when configured) with `jose` — the SAME library
//              Paddock uses. Warren uses a shared HS256 secret rather than a
//              remote JWKS so a small self-hosted deploy needs no IdP.
//
// The hook guards `/api/*` (the dashboard's data plane). Exempt always: `/healthz`
// (probes) and `/api/auth-mode` (so the UI can discover the mode BEFORE it has a
// token). The static dashboard shell at `/` is served open — it carries no data
// and is what lets a browser user enter a token (stored in localStorage) that the
// SPA then sends as `Bearer` on the guarded `/api/*` calls. 401 on missing/invalid.
//
// Registered BEFORE routes so the `onRequest` hook runs first. The secret is
// NEVER logged (only its presence, in redactedEnv).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";

import type { WarrenAuthConfig } from "../config/env.js";
import type { Logger } from "../types.js";

/** Paths that must never require auth (probes + auth-mode discovery). */
const EXEMPT_PATHS = new Set<string>(["/healthz", "/api/auth-mode"]);

/** Only the data plane is guarded; the static shell + probes stay open. */
function isGuarded(url: string): boolean {
  const p = normalizePath(url);
  if (EXEMPT_PATHS.has(p)) return false;
  return p === "/api" || p.startsWith("/api/");
}

/** Strip the query string and a trailing slash so matching is robust. */
function normalizePath(url: string): string {
  const q = url.indexOf("?");
  let p = q === -1 ? url : url.slice(0, q);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Extract a bearer token from the Authorization header, or undefined. */
function bearerToken(req: FastifyRequest): string | undefined {
  const raw = req.headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * Register the auth layer on `app`. In `jwt` mode a fatal misconfiguration (no
 * secret) throws at registration time so the operator gets a clear startup
 * failure instead of a server that rejects every request — failing closed but
 * loudly, exactly like Paddock.
 */
export function registerAuth(
  app: FastifyInstance,
  auth: WarrenAuthConfig,
  logger?: Logger,
): void {
  if (auth.mode === "none") {
    logger?.info("auth: mode=none (open access)");
    return;
  }

  // mode === "jwt"
  if (!auth.jwtSecret) {
    throw new Error(
      "auth: WARREN_AUTH_MODE=jwt requires WARREN_JWT_SECRET (the HS256 signing secret)",
    );
  }
  const secret = new TextEncoder().encode(auth.jwtSecret);
  logger?.info(
    `auth: mode=jwt (verifying HS256 bearer tokens${
      auth.jwtIssuer ? `, iss=${auth.jwtIssuer}` : ""
    }${auth.jwtAudience ? `, aud=${auth.jwtAudience}` : ""})`,
  );

  app.addHook("onRequest", async (req, reply) => {
    if (!isGuarded(req.url)) return;

    const token = bearerToken(req);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", code: "auth_required" });
    }
    try {
      await jwtVerify(token, secret, {
        ...(auth.jwtIssuer ? { issuer: auth.jwtIssuer } : {}),
        ...(auth.jwtAudience ? { audience: auth.jwtAudience } : {}),
      });
    } catch {
      // Invalid signature, expired, wrong issuer/audience, malformed, etc.
      return reply.code(401).send({ error: "invalid token", code: "auth_invalid" });
    }
  });
}
