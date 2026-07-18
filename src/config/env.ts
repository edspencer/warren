// src/config/env.ts — typed access to process.env. Secrets (GITHUB_TOKEN,
// ANTHROPIC_API_KEY) are read here but NEVER logged; use `redactedEnv()` for
// any diagnostic dump.

export interface WarrenEnv {
  /** GitHub token for reads (and live writes). Secret — never log. */
  githubToken?: string;
  /** Anthropic API key (only used when runtime === "sdk"). Secret — never log. */
  anthropicApiKey?: string;
  /** Agent runtime: "cli" (Claude Code / Max plan) or "sdk". */
  runtime: "cli" | "sdk";
  /** Resolved live/dry-run flag: WARREN_LIVE truthy ("1"/"true") => live. */
  live: boolean;
  /** HTTP server port (PORT or WARREN_PORT). */
  port: number;
  /** HTTP server bind host. */
  host: string;
  /** Watched repos parsed from WARREN_REPOS (csv of owner/name). */
  repos: string[];
  /** Base directory for JSON state + captured dry-run write payloads. */
  dataDir: string;
  /** Optional explicit path to the server `.warren.yaml` (WARREN_CONFIG). When
   *  unset the container falls back to `<cwd>/.warren.yaml`. */
  configPath?: string;
  /** Dashboard/API authentication (installer-configured; mirrors Paddock). */
  auth: WarrenAuthConfig;
}

/**
 * Dashboard/API auth config. Mirrors Paddock's `PADDOCK_AUTH_*` mode-select
 * (see paddock server auth.ts): an installer picks `none` (open, default) or
 * `jwt` (require a signed `Authorization: Bearer <jwt>`). Warren verifies with
 * the same library (`jose`) and validates `iss`/`aud`/`exp` like Paddock; it
 * uses a shared HS256 secret (`WARREN_JWT_SECRET`) rather than a remote JWKS so
 * a small self-hosted deploy needs no IdP. The secret is NEVER logged.
 */
export interface WarrenAuthConfig {
  mode: "none" | "jwt";
  /** jwt: HS256 shared secret used to verify the token signature. Secret. */
  jwtSecret?: string;
  /** jwt: expected `iss` claim (validated when set). */
  jwtIssuer?: string;
  /** jwt: expected `aud` claim (validated when set). */
  jwtAudience?: string;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

function csv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read Warren's environment into a typed, defaulted `WarrenEnv`. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): WarrenEnv {
  const runtime = (source.WARREN_RUNTIME ?? "cli").trim().toLowerCase();
  const portRaw = source.WARREN_PORT ?? source.PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : 5000;
  const authMode = (source.WARREN_AUTH_MODE ?? "none").trim().toLowerCase();
  return {
    githubToken: source.GITHUB_TOKEN || undefined,
    anthropicApiKey: source.ANTHROPIC_API_KEY || undefined,
    runtime: runtime === "sdk" ? "sdk" : "cli",
    live: truthy(source.WARREN_LIVE),
    port: Number.isFinite(port) ? port : 5000,
    host: source.HOST || source.WARREN_HOST || "0.0.0.0",
    repos: csv(source.WARREN_REPOS),
    dataDir: source.WARREN_DATA_DIR || "./data",
    configPath: source.WARREN_CONFIG || undefined,
    auth: {
      mode: authMode === "jwt" ? "jwt" : "none",
      jwtSecret: source.WARREN_JWT_SECRET || undefined,
      jwtIssuer: source.WARREN_JWT_ISSUER || undefined,
      jwtAudience: source.WARREN_JWT_AUDIENCE || undefined,
    },
  };
}

/**
 * A log-safe view of the env: secret presence is reported as a boolean, never
 * the value. Use this (not `readEnv`) whenever env is printed/serialized.
 */
export function redactedEnv(env: WarrenEnv): Record<string, unknown> {
  return {
    hasGithubToken: !!env.githubToken,
    hasAnthropicApiKey: !!env.anthropicApiKey,
    runtime: env.runtime,
    live: env.live,
    port: env.port,
    host: env.host,
    repos: env.repos,
    dataDir: env.dataDir,
    configPath: env.configPath,
    authMode: env.auth.mode,
    hasJwtSecret: !!env.auth.jwtSecret,
    hasJwtIssuer: !!env.auth.jwtIssuer,
    hasJwtAudience: !!env.auth.jwtAudience,
  };
}
