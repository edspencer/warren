// src/config/load.ts — read + parse a `.warren.yaml`, validate against the Zod
// schema, deep-merge over server defaults, apply env overrides, and resolve
// per-repo config. Missing file => all-defaults.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { WarrenConfigZ } from "./schema.js";
import type { WarrenConfig, RepoConfig } from "../types.js";
import type { WarrenEnv } from "./env.js";

/** The all-defaults server config (equivalent to an empty `.warren.yaml`). */
export function defaultWarrenConfig(): WarrenConfig {
  return WarrenConfigZ.parse({});
}

/** Validate an already-parsed (plain object) config blob. Throws on invalid. */
export function parseWarrenConfig(raw: unknown): WarrenConfig {
  return WarrenConfigZ.parse(raw ?? {});
}

/** Is this the "file not found" error? */
function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

/**
 * Load a `.warren.yaml` from disk. A missing file yields the all-defaults
 * config. The parsed file is validated by the schema (which applies defaults
 * for every omitted key — i.e. a deep merge OVER the server defaults). When an
 * `env` is supplied, `WARREN_LIVE` takes precedence over the file's `live`.
 */
export async function loadWarrenConfig(
  filePath: string,
  env?: WarrenEnv,
): Promise<WarrenConfig> {
  let raw: unknown = {};
  try {
    const text = await readFile(filePath, "utf8");
    raw = parseYaml(text) ?? {};
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // missing file -> all defaults
    raw = {};
  }
  const config = parseWarrenConfig(raw);
  return applyEnvOverrides(config, env);
}

/**
 * Env precedence: `WARREN_LIVE` (env) > repo `.warren.yaml` > server defaults.
 * Only `live` is env-overridable here (other env lives in config/env.ts).
 */
export function applyEnvOverrides(config: WarrenConfig, env?: WarrenEnv): WarrenConfig {
  if (!env) return config;
  return { ...config, live: env.live || config.live };
}

/** Recursive plain-object deep merge (arrays + scalars from `override` win). */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (
    base &&
    typeof base === "object" &&
    !Array.isArray(base) &&
    override &&
    typeof override === "object" &&
    !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    return out as T;
  }
  return override as T;
}

/**
 * Resolve the effective config for one repo: deep-merge its `overrides`
 * (camelCase partial) over the server config. `repos` is dropped from the
 * result since it is server-level only.
 */
export function resolveRepoConfig(server: WarrenConfig, repo: RepoConfig): WarrenConfig {
  const { repos: _drop, ...serverNoRepos } = server;
  const merged = deepMerge(serverNoRepos, repo.overrides) as Omit<WarrenConfig, "repos">;
  return { ...merged, repos: server.repos };
}
