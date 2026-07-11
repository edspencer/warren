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
  return {
    githubToken: source.GITHUB_TOKEN || undefined,
    anthropicApiKey: source.ANTHROPIC_API_KEY || undefined,
    runtime: runtime === "sdk" ? "sdk" : "cli",
    live: truthy(source.WARREN_LIVE),
    port: Number.isFinite(port) ? port : 5000,
    host: source.HOST || source.WARREN_HOST || "0.0.0.0",
    repos: csv(source.WARREN_REPOS),
    dataDir: source.WARREN_DATA_DIR || "./data",
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
  };
}
