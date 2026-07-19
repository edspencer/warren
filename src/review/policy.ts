// src/review/policy.ts — pure review-policy helpers used by the pipeline.
//
// Three concerns, all side-effect-free and unit-testable:
//   • release-ONLY diff detection (skip mechanical churn once files are known);
//   • soft budget ceilings (max_files / max_tokens) to skip giant/generated PRs;
//   • the `review.effort` knob → concrete pipeline behavior (triage/verify/turns).
//
// The by-title/branch/author release heuristic lives in trigger/policy.ts (it runs
// pre-materialize, at poll time). THIS module's release check needs the materialized
// file list, so it lives beside the pipeline.

import type { ResolvedExecutionMode, WarrenConfig } from "../types.js";
import { isAuthorAllowed } from "../trigger/policy.js";

// ─────────────────────────── Release-only diff ───────────────────────────

/** Path patterns that are pure release/version churn (lockfiles, changelog, changesets). */
const RELEASE_PATH_TESTS: RegExp[] = [
  /(^|\/)CHANGELOG(\.md)?$/i,
  /(^|\/)\.changeset\//i, // .changeset/*.md + config
  /(^|\/)package-lock\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)bun\.lockb$/i,
  /(^|\/)npm-shrinkwrap\.json$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)go\.sum$/i,
];

/** True when a single path is pure release/version churn. */
export function isReleasePath(path: string): boolean {
  return RELEASE_PATH_TESTS.some((re) => re.test(path));
}

/**
 * True when EVERY changed path is release churn (and there is at least one file).
 * Used to skip a PR whose diff only bumps lockfiles / CHANGELOG / .changeset even
 * when its title/branch/author didn't trip the trigger-time heuristic.
 */
export function isReleaseDiff(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isReleasePath);
}

// ─────────────────────────── Budget ceilings ───────────────────────────

/** Cheap token estimate from character count (~4 chars/token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface DiffSize {
  fileCount: number;
  diffChars: number; // total characters of the unified diff
}

/**
 * Returns a human reason when the diff exceeds a configured soft ceiling, else null.
 * A `0` ceiling means "no cap". Enforced before spending any review tokens.
 */
export function budgetSkipReason(size: DiffSize, review: WarrenConfig["review"]): string | null {
  if (review.maxFiles > 0 && size.fileCount > review.maxFiles) {
    return `changed files ${size.fileCount} exceed review.max_files ${review.maxFiles}`;
  }
  if (review.maxTokens > 0) {
    const tokens = estimateTokens(size.diffChars);
    if (tokens > review.maxTokens) {
      return `estimated diff tokens ${tokens} exceed review.max_tokens ${review.maxTokens}`;
    }
  }
  return null;
}

// ─────────────────────────── Effort knob ───────────────────────────

export interface EffortSettings {
  /** Run the cheap triage pre-pass. */
  triage: boolean;
  /** Run the adversarial verify pass. */
  verify: boolean;
  /** Reviewer agent turn budget (a reasoning-effort proxy — herdctl has no
   *  native reasoning-effort field, so thoroughness is spent as turns). */
  reviewerMaxTurns: number;
}

/**
 * Map `review.effort` to concrete pipeline behavior:
 *   • low    — cheapest: no triage, NO verify, tight turn budget. Fast/cheap sweeps.
 *   • normal — default: no triage, verify ON (precision), standard budget.
 *   • high   — thorough: triage ON, verify ON, generous budget.
 */
export function effortSettings(effort: WarrenConfig["review"]["effort"]): EffortSettings {
  switch (effort) {
    case "low":
      return { triage: false, verify: false, reviewerMaxTurns: 15 };
    case "high":
      return { triage: true, verify: true, reviewerMaxTurns: 45 };
    case "normal":
    default:
      return { triage: false, verify: true, reviewerMaxTurns: 30 };
  }
}

// ─────────────────────────── Execution policy (SECURITY) ───────────────────────────

/**
 * Resolve the configured `review.execution` mode against the PR author into a concrete
 * per-review capability: `static` (NO Bash — PR code is inspected, never executed) or
 * `full` (Bash allowed). SECURITY-CRITICAL — this is what decides whether untrusted PR
 * code can run arbitrary commands on the host.
 *
 *   • `static`  → always `static` (default; safest).
 *   • `full`    → always `full` (repo owner has explicitly opted this repo into exec).
 *   • `trusted` → `full` ONLY when the author is on `auto_review.authors` (a NON-EMPTY
 *                 allowlist); everyone else — including every author when the allowlist
 *                 is empty — gets `static`. This is the recommended posture for a repo
 *                 that takes outside contributions: your own PRs run, strangers' don't.
 *
 * Fails safe: any unrecognized mode collapses to `static`.
 */
export function resolveExecution(cfg: WarrenConfig, author: string | undefined): ResolvedExecutionMode {
  const mode = cfg.review.execution;
  if (mode === "full") return "full";
  if (mode === "trusted") {
    const allow = cfg.autoReview.authors;
    // isAuthorAllowed returns true for an EMPTY allowlist ("review everyone"); for the
    // execution gate an empty allowlist must mean "trust no one" → static. So require a
    // non-empty allowlist AND membership.
    return allow.length > 0 && isAuthorAllowed(author, allow) ? "full" : "static";
  }
  return "static";
}
