// src/trigger/policy.ts — pure, side-effect-free auto-review eligibility policy.
//
// These helpers decide whether a PR is eligible for AUTO review, and whether an
// @warren command on it is honored, given the resolved `autoReview` config. They
// take only plain data (a PrLike) so they are trivially unit-testable without a
// GitHubClient, poll loop, or state store. The PollTriggerSource wires them into
// its emit path (see poll.ts).
//
// Layering: author allow/deny + label gating apply to BOTH auto review and
// explicit @warren commands (a denied author / warren:skip label should silence
// both channels). The release-PR and title/branch ignore heuristics apply ONLY to
// auto review — a human who types `@warren review` on a release PR is obeyed.

import type { WarrenConfig } from "../types.js";

/** The subset of PR fields the policy needs. Mirrors github/client.ts PrInfo. */
export interface PrLike {
  title: string;
  headRef: string; // branch name
  author: string;
  labels: string[];
}

/** The resolved `autoReview` block (camelCase). */
type AutoReview = WarrenConfig["autoReview"];

// ─────────────────────────── Built-in release heuristics ───────────────────────────
// Additive: a repo's custom *_patterns / release_authors are appended to these.

/** Title patterns that mark a mechanical version/release PR (case-insensitive). */
export const DEFAULT_RELEASE_TITLE_PATTERNS = [
  "^chore:\\s*version packages", // changesets "Version Packages" PR (+scope variants)
  "^chore\\(release\\)", // conventional release commits
  "^release[:/ ]", // "release: v1.2.3", "release/1.2"
  "^v?\\d+\\.\\d+\\.\\d+", // bare version-bump titles like "1.2.3" / "v1.2.3"
  "\\bversion packages\\b",
  "\\brelease\\b.*\\bv?\\d+\\.\\d+", // "Release v1.2"
];

/** Branch patterns that mark a release-automation branch (case-insensitive). */
export const DEFAULT_RELEASE_BRANCH_PATTERNS = [
  "^changeset-release/", // changesets action
  "^release-please", // release-please
  "^release/", // conventional release branches
  "^(dependabot|renovate)/", // dependency-bump automation branches
];

/** Logins commonly used by release/version automation. */
export const DEFAULT_RELEASE_AUTHORS = [
  "github-actions[bot]",
  "changeset-bot[bot]",
  "release-please[bot]",
  "dependabot[bot]",
  "renovate[bot]",
];

// ─────────────────────────── Matching primitives ───────────────────────────

/**
 * True when `text` matches ANY pattern. Each pattern is tried as a case-insensitive
 * RegExp; an invalid regex degrades gracefully to a case-insensitive substring test
 * (so a config typo can never throw at poll time).
 */
export function matchesAnyPattern(text: string, patterns: string[]): boolean {
  if (!text || patterns.length === 0) return false;
  for (const p of patterns) {
    if (!p) continue;
    let re: RegExp | null = null;
    try {
      re = new RegExp(p, "i");
    } catch {
      re = null;
    }
    if (re) {
      if (re.test(text)) return true;
    } else if (text.toLowerCase().includes(p.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/** Case-insensitive login membership. */
function loginIn(login: string | undefined, list: string[]): boolean {
  if (!login || list.length === 0) return false;
  const want = login.toLowerCase();
  return list.some((l) => l.toLowerCase() === want);
}

// ─────────────────────────── Author gates ───────────────────────────

/**
 * Author allowlist gate (SAFETY, issue #21). Returns true when `login` is allowed
 * to be reviewed/commented on. An empty allowlist means no gating — everyone is
 * allowed (legacy behavior). Matching is case-insensitive (GitHub logins are).
 */
export function isAuthorAllowed(login: string | undefined, authors: string[]): boolean {
  if (authors.length === 0) return true;
  return loginIn(login, authors);
}

/** Author denylist gate (#26). True when `login` is explicitly denied. */
export function isAuthorDenied(login: string | undefined, denyAuthors: string[]): boolean {
  return loginIn(login, denyAuthors);
}

// ─────────────────────────── Label gate ───────────────────────────

/**
 * Label gating. Returns true when the PR's labels permit review:
 *   • a PR carrying ANY `skipLabels` label is blocked;
 *   • when `onlyLabels` is NON-EMPTY, the PR must carry at least one of them.
 * Matching is case-insensitive. Empty label lists impose no constraint.
 */
export function labelGateAllows(
  labels: string[],
  skipLabels: string[],
  onlyLabels: string[],
): boolean {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  if (skipLabels.some((l) => have.has(l.toLowerCase()))) return false;
  if (onlyLabels.length > 0 && !onlyLabels.some((l) => have.has(l.toLowerCase()))) return false;
  return true;
}

// ─────────────────────────── Release-PR heuristic ───────────────────────────

/**
 * True when the PR looks like a mechanical version/release PR by title, branch, or
 * author (built-in defaults + the repo's additive custom patterns). Note: the
 * release-ONLY-diff check (lockfiles/CHANGELOG/.changeset) lives in review/policy.ts
 * because it needs the materialized file list.
 */
export function isReleasePr(pr: PrLike, ar: AutoReview): boolean {
  const titlePatterns = [...DEFAULT_RELEASE_TITLE_PATTERNS, ...ar.releaseTitlePatterns];
  const branchPatterns = [...DEFAULT_RELEASE_BRANCH_PATTERNS, ...ar.releaseBranchPatterns];
  const authors = [...DEFAULT_RELEASE_AUTHORS, ...ar.releaseAuthors];
  return (
    matchesAnyPattern(pr.title, titlePatterns) ||
    matchesAnyPattern(pr.headRef, branchPatterns) ||
    loginIn(pr.author, authors)
  );
}

// ─────────────────────────── Combined decisions ───────────────────────────

export interface AutoReviewDecision {
  allow: boolean;
  /** Short machine-ish reason when blocked (for debug logging). */
  reason?: string;
}

/**
 * Whether an explicit @warren command on this PR is honored. Gated on AUTHOR
 * POLICY ONLY (allow/denylist) — a permission/safety gate. The scope/noise
 * filters (label gating, title/branch ignore patterns, release-PR skip, drafts)
 * exist to keep AUTO review quiet; a maintainer who explicitly types `@warren
 * review` has opted in, so those filters must NOT silently drop the request
 * (e.g. `only_labels` set + an unlabeled PR still gets a manual review). Only the
 * author allow/deny gate — which is a documented permission control — applies here.
 * Pause/resume are handled upstream and are always allowed.
 */
export function commandAllowed(pr: PrLike, ar: AutoReview): boolean {
  if (isAuthorDenied(pr.author, ar.denyAuthors)) return false;
  if (!isAuthorAllowed(pr.author, ar.authors)) return false;
  return true;
}

/**
 * Whether this PR is eligible for AUTO review. Applies every gate; returns the
 * first failing reason for observability. Draft + base-branch checks stay in the
 * poll loop (they need no policy context). An all-default config allows every PR
 * that isn't a release PR — matching prior behavior save for the new release skip.
 */
export function autoReviewDecision(pr: PrLike, ar: AutoReview): AutoReviewDecision {
  if (isAuthorDenied(pr.author, ar.denyAuthors)) {
    return { allow: false, reason: `author '${pr.author}' on deny_authors` };
  }
  if (!isAuthorAllowed(pr.author, ar.authors)) {
    return { allow: false, reason: `author '${pr.author}' not on authors allowlist` };
  }
  if (!labelGateAllows(pr.labels, ar.skipLabels, ar.onlyLabels)) {
    return { allow: false, reason: "blocked by label gate (skip_labels/only_labels)" };
  }
  if (matchesAnyPattern(pr.title, ar.skipTitlePatterns)) {
    return { allow: false, reason: "title matched skip_title_patterns" };
  }
  if (matchesAnyPattern(pr.headRef, ar.skipBranchPatterns)) {
    return { allow: false, reason: "branch matched skip_branch_patterns" };
  }
  if (ar.skipReleasePrs && isReleasePr(pr, ar)) {
    return { allow: false, reason: "looks like a release/version PR (skip_release_prs)" };
  }
  return { allow: true };
}
