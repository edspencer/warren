// src/types.ts — Warren core domain types.
//
// This is the ROOT module: it imports nothing from other Warren modules.
// Everything downstream (config, github, review, herd, trigger, server) depends
// only on the pure types + tiny helpers exported here.

// ─────────────────────────── Trigger / events ───────────────────────────

export type ReviewReason =
  | "new_pr" // first time we've seen this PR
  | "new_head" // head SHA changed (push / synchronize)
  | "command" // @warren review / full review
  | "manual"; // hand-triggered (M0 spike, tests)

export interface ReviewEvent {
  target: ReviewTarget; // what to review (discriminated union below)
  reason: ReviewReason;
  full: boolean; // true = ignore lastReviewedSha, review whole diff
  command?: WarrenCommand; // present when reason === "command"
  requestedBy?: string; // GitHub login that triggered a command, if any
  receivedAt: string; // ISO timestamp
}

// ─────────────────────────── Review target ──────────────────────────────
// Discriminated union on `kind`. The pipeline is target-agnostic; only the
// ReviewTargetProvider knows how to materialize each.

export interface GithubPrTarget {
  kind: "github-pr";
  repo: RepoRef; // { owner, name }
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string; // e.g. "main"
}

export interface LocalGitTarget {
  kind: "local-git";
  repoDir: string; // abs path to a local git repo (the testbed)
  baseRef: string; // e.g. "main"
  headRef: string; // e.g. "pr/seeded-issues"
  // Synthetic identity so state/fingerprints/keys work uniformly:
  label: string; // stable name used as the "pr" key, e.g. "local:seeded-issues"
}

export type ReviewTarget = GithubPrTarget | LocalGitTarget;

export interface RepoRef {
  owner: string;
  name: string;
}

/** Canonical string key for state store + queue keying. */
export function targetKey(t: ReviewTarget): string {
  return t.kind === "github-pr"
    ? `github:${t.repo.owner}/${t.repo.name}#${t.prNumber}`
    : `localgit:${t.repoDir}@${t.label}`;
}

/** Head SHA to record as lastReviewedSha (resolved for local-git by the provider). */
export function targetHeadSha(t: ReviewTarget): string {
  return t.kind === "github-pr" ? t.headSha : ""; // local-git resolves at provider time
}

// ─────────────────────────── Findings ───────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "nit";

export type FindingCategory =
  | "bug"
  | "security"
  | "performance"
  | "correctness"
  | "maintainability"
  | "style"
  | "test"
  | "docs";

export type DiffSide = "LEFT" | "RIGHT";

export interface Finding {
  path: string; // repo-relative file path
  line: number; // 1-based line in the file at `side`
  endLine?: number; // multi-line range end (inclusive); >= line
  side: DiffSide; // RIGHT = added/context (default), LEFT = removed
  severity: Severity;
  category: FindingCategory;
  title: string; // one-line summary
  body: string; // markdown explanation (evidence-grounded)
  suggestion?: string; // raw replacement code for a ```suggestion``` block (no fences)
  confidence: number; // 0..1 post-verify confidence
  fingerprint: string; // stable dedup hash (see review/fingerprint.ts)
  verified: boolean; // survived the adversarial verify pass
}

/**
 * A finding as emitted by the review agent, before Warren computes the
 * fingerprint and runs the verify pass. `confidence` is optional/pre-verify;
 * `fingerprint` and `verified` are filled in downstream.
 */
export type RawFinding = Omit<Finding, "fingerprint" | "verified" | "confidence"> & {
  confidence?: number;
};

// ─────────────────────────── Review result ──────────────────────────────

export interface ReviewStats {
  filesReviewed: number;
  hunksReviewed: number; // total diff hunks across changed files (coverage signal)
  findingsRaw: number; // emitted by review pass
  findingsVerified: number; // survived verify
  findingsPosted: number; // after severity gate + dedup
  coverage: string; // one-line human coverage signal (rendered in the walkthrough)
  durationMs: number;
  triageModel: string;
  reviewModel: string;
  verifyModel: string;
}

export interface ReviewResult {
  target: ReviewTarget;
  summary: string; // short markdown summary (top of the review body)
  walkthrough: string; // markdown walkthrough (sticky comment body)
  findings: Finding[]; // the POSTED findings (already gated + deduped)
  stats: ReviewStats;
  posted: boolean; // true if a review was actually emitted (live or dry-run capture)
  sessionId?: string; // herdctl session id for resume/chat (phase 3)
}

// ─────────────────────────── Commands ───────────────────────────────────

export type WarrenCommandKind =
  | "review" // incremental review now
  | "full_review" // full review now (ignore lastReviewedSha)
  | "pause" // stop auto-reviewing this PR
  | "resume" // re-enable auto-review
  | "resolve" // resolve all open Warren threads
  | "help"; // post the help text

export interface WarrenCommand {
  kind: WarrenCommandKind;
  raw: string; // the original comment text (for logging)
  commentId?: number; // source comment id (for eyes-reaction ack)
  author?: string; // login of commenter
}

// ─────────────────────────── Config types ───────────────────────────────
// Defined here (not config/schema.ts) so `types.ts` stays the single root and
// the slug/repoLabel helpers below can reference RepoConfig without importing.
// config/schema.ts builds the Zod schema whose transform PRODUCES these shapes,
// and re-exports these type names for the config seam.

export interface WarrenConfig {
  profile: "chill" | "assertive";
  minSeverity: Severity; // findings below this are dropped
  trigger: {
    mode: "poll" | "webhook" | "tunnel";
    pollIntervalMs: number; // poll mode only
    secretEnv?: string; // webhook/tunnel: env var name holding HMAC secret
    publicUrl?: string; // webhook/tunnel docs only
  };
  autoReview: {
    enabled: boolean;
    drafts: boolean;
    baseBranches: string[]; // only auto-review PRs targeting these
  };
  pathFilters: string[]; // gitignore-style; "!" prefix = exclude
  pathInstructions: Array<{ path: string; instructions: string }>;
  walkthrough: { sequenceDiagrams: boolean; poem: boolean };
  commandsAllowed: WarrenCommandKind[];
  models: { triage: string; review: string; verify: string };
  live: boolean; // resolved: WARREN_LIVE OR config; false = dry-run
  repos: RepoConfig[]; // watched repos (server-level config)
  concurrency: number; // max parallel reviews (JobQueue)
}

export interface RepoConfig {
  // Exactly one of the following selects the target kind:
  github?: { owner: string; name: string };
  localGit?: { repoDir: string; baseRef: string; headRef: string; label: string };
  // Per-repo overrides (merged over server WarrenConfig):
  overrides?: Partial<Omit<WarrenConfig, "repos">>;
}

// ─────────────────────────── Shared helpers ─────────────────────────────

/** A minimal structured logger; concrete impls live in the container. */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** Deterministic, filesystem/agent-safe slug for a repo (used as agent-name stem). */
export function slug(repo: RepoConfig): string {
  const raw = repo.github
    ? `${repo.github.owner}-${repo.github.name}`
    : repo.localGit
      ? repo.localGit.label
      : "unknown";
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

/** Human-readable label for a repo (logs, agent descriptions). */
export function repoLabel(repo: RepoConfig): string {
  if (repo.github) return `${repo.github.owner}/${repo.github.name}`;
  if (repo.localGit) return repo.localGit.label;
  return "unknown";
}
