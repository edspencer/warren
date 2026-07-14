// src/config/schema.ts — Zod schema for `.warren.yaml` (snake_case on disk) +
// a transform that maps it to the camelCase `WarrenConfig` domain type.
// NO I/O here (see config/load.ts for file reads + merge).

import { z } from "zod";
import type { RepoConfig, WarrenConfig } from "../types.js";

// Re-export the domain config types so downstream code can import them from the
// config seam (per spec §3.1) as well as from types.ts.
export type { RepoConfig, WarrenConfig } from "../types.js";

const SeverityZ = z.enum(["critical", "high", "medium", "low", "nit"]);
const CommandZ = z.enum(["review", "full_review", "pause", "resume", "resolve", "help", "ask"]);

/** "60s" | "5m" | 60000 -> ms */
const DurationMsZ = z
  .union([z.number().int().positive(), z.string()])
  .transform((v, ctx) => {
    if (typeof v === "number") return v;
    const m = /^(\d+)(ms|s|m|h)?$/.exec(v.trim());
    if (!m) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bad duration: ${v}` });
      return z.NEVER;
    }
    const n = Number(m[1]);
    const u = (m[2] ?? "ms") as "ms" | "s" | "m" | "h";
    return n * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u];
  });

const RepoConfigZ = z
  .object({
    github: z.object({ owner: z.string(), name: z.string() }).optional(),
    local_git: z
      .object({
        repo_dir: z.string(),
        base_ref: z.string(),
        head_ref: z.string(),
        label: z.string(),
      })
      .optional(),
    // partial WarrenConfig (snake_case); validated/mapped on merge in load.ts
    overrides: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((r) => !!r.github !== !!r.local_git, "exactly one of github|local_git");

/**
 * The raw (pre-transform) schema. Kept separate so its inferred type feeds the
 * `toWarrenConfig` transform below with full type-safety.
 *
 * NOTE: model default ids below OVERRIDE the stale placeholders in the spec —
 * per the build order they are the corrected, current ids.
 */
const WarrenConfigRawZ = z.object({
  profile: z.enum(["chill", "assertive"]).default("chill"),
  // Default `low` so genuine low-severity findings (a narrow race, a resource
  // inefficiency) surface as findings instead of being self-censored into prose.
  // Only `nit` is dropped by default; `nit` surfaces under profile=assertive.
  // Precision is preserved by the adversarial verify pass, not by suppressing severity.
  min_severity: SeverityZ.default("low"),
  trigger: z
    .object({
      mode: z.enum(["poll", "webhook", "tunnel"]).default("poll"),
      poll_interval: DurationMsZ.default("60s"),
      secret_env: z.string().optional(),
      public_url: z.string().url().optional(),
    })
    .default({}),
  auto_review: z
    .object({
      enabled: z.boolean().default(true),
      drafts: z.boolean().default(false),
      base_branches: z.array(z.string()).default(["main"]),
    })
    .default({}),
  path_filters: z
    .array(z.string())
    .default(["!**/dist/**", "!**/*.lock", "!**/node_modules/**"]),
  path_instructions: z
    .array(z.object({ path: z.string(), instructions: z.string() }))
    .default([]),
  walkthrough: z
    .object({
      sequence_diagrams: z.boolean().default(false),
      poem: z.boolean().default(false),
    })
    .default({}),
  commands_allowed: z
    .array(CommandZ)
    .default(["review", "full_review", "pause", "resume", "resolve", "help", "ask"]),
  models: z
    .object({
      // CORRECTED model ids (spec placeholders were stale):
      triage: z.string().default("claude-haiku-4-5-20251001"),
      review: z.string().default("claude-opus-4-8"),
      verify: z.string().default("claude-haiku-4-5-20251001"),
    })
    .default({}),
  // Auto-resolve a fixed finding's review thread on re-review. Default true.
  resolve_on_fix: z.boolean().default(true),
  live: z.boolean().default(false), // env WARREN_LIVE overrides in load.ts
  concurrency: z.number().int().positive().default(3),
  repos: z.array(RepoConfigZ).default([]),
});

export type WarrenConfigRaw = z.infer<typeof WarrenConfigRawZ>;
type RepoConfigRaw = z.infer<typeof RepoConfigZ>;

/** Generic recursive snake_case -> camelCase key mapper (used for repo overrides). */
function toCamelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
function deepCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toCamelKey(k)] = deepCamel(v);
    }
    return out;
  }
  return value;
}

/**
 * Map a per-repo `overrides` blob (snake_case, partial) into the camelCase
 * `Partial<WarrenConfig>` shape. `poll_interval` is left as-authored (string|number);
 * config/load.ts normalizes it during the merge/re-parse.
 */
function mapOverrides(
  raw: Record<string, unknown> | undefined,
): Partial<Omit<WarrenConfig, "repos">> | undefined {
  if (!raw) return undefined;
  return deepCamel(raw) as Partial<Omit<WarrenConfig, "repos">>;
}

function mapRepo(r: RepoConfigRaw): RepoConfig {
  const out: RepoConfig = {};
  if (r.github) out.github = { owner: r.github.owner, name: r.github.name };
  if (r.local_git) {
    out.localGit = {
      repoDir: r.local_git.repo_dir,
      baseRef: r.local_git.base_ref,
      headRef: r.local_git.head_ref,
      label: r.local_git.label,
    };
  }
  const ov = mapOverrides(r.overrides as Record<string, unknown> | undefined);
  if (ov) out.overrides = ov;
  return out;
}

/** snake_case raw config -> camelCase WarrenConfig domain type. */
export function toWarrenConfig(raw: WarrenConfigRaw): WarrenConfig {
  return {
    profile: raw.profile,
    minSeverity: raw.min_severity,
    trigger: {
      mode: raw.trigger.mode,
      pollIntervalMs: raw.trigger.poll_interval,
      ...(raw.trigger.secret_env !== undefined ? { secretEnv: raw.trigger.secret_env } : {}),
      ...(raw.trigger.public_url !== undefined ? { publicUrl: raw.trigger.public_url } : {}),
    },
    autoReview: {
      enabled: raw.auto_review.enabled,
      drafts: raw.auto_review.drafts,
      baseBranches: raw.auto_review.base_branches,
    },
    pathFilters: raw.path_filters,
    pathInstructions: raw.path_instructions.map((p) => ({
      path: p.path,
      instructions: p.instructions,
    })),
    walkthrough: {
      sequenceDiagrams: raw.walkthrough.sequence_diagrams,
      poem: raw.walkthrough.poem,
    },
    commandsAllowed: raw.commands_allowed,
    models: {
      triage: raw.models.triage,
      review: raw.models.review,
      verify: raw.models.verify,
    },
    resolveOnFix: raw.resolve_on_fix,
    live: raw.live,
    concurrency: raw.concurrency,
    repos: raw.repos.map(mapRepo),
  };
}

/** The public schema: parse a `.warren.yaml` object -> WarrenConfig (camelCase). */
export const WarrenConfigZ = WarrenConfigRawZ.transform(toWarrenConfig);

/** Also expose the raw schema for callers that need the pre-transform shape. */
export { WarrenConfigRawZ, RepoConfigZ };
