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
  | "help" // post the help text
  | "ask"; // free-form Q&A: resume the reviewer session and answer

export interface WarrenCommand {
  kind: WarrenCommandKind;
  raw: string; // the original comment text (for logging)
  commentId?: number; // source comment id (for eyes-reaction ack / answer dedup)
  author?: string; // login of commenter
  /** For kind==="ask": the free-form question text (mention stripped). */
  question?: string;
  /** Source-comment channel: "review" = diff-thread reply, "issue" = PR conversation. */
  commentKind?: "issue" | "review";
  /**
   * GitHub `author_association` of the COMMENTER (OWNER/MEMBER/COLLABORATOR/
   * CONTRIBUTOR/NONE/…), used to authorize who may trigger @warren commands
   * (see trigger/policy.ts commandAssociationAllowed). Uppercased; may be undefined.
   */
  authorAssociation?: string;
}

// ─────────────────────────── Config types ───────────────────────────────
// Defined here (not config/schema.ts) so `types.ts` stays the single root and
// the slug/repoLabel helpers below can reference RepoConfig without importing.
// config/schema.ts builds the Zod schema whose transform PRODUCES these shapes,
// and re-exports these type names for the config seam.

/**
 * How much host access the review agent gets on the UNTRUSTED checkout.
 *   • `static`  — Read/Grep/Glob/Task only; NO Bash (PR code is inspected, never run).
 *   • `full`    — Bash allowed (arbitrary exec on the checkout); fully-trusted repos only.
 *   • `trusted` — resolves to `full` for allowlisted authors, else `static`.
 * The RESOLVED per-review mode is only ever `static` | `full` (see resolveExecution).
 */
export type ExecutionMode = "static" | "full" | "trusted";

/** The resolved, per-review execution mode (never `trusted` — that's resolved away). */
export type ResolvedExecutionMode = "static" | "full";

/**
 * Sandbox posture for the review agent (SECURITY.md). `docker` is DESIGN-ONLY today —
 * the schema + knobs exist so a deploy can express intent, but the container runtime
 * is not yet wired (this box has no docker CLI to exercise it). `none` (default) runs
 * the agent in-process on the host, boxed by the `execution` tool policy above.
 */
export interface SandboxConfig {
  /** `none` (default, implemented) | `docker` (design-only; see SECURITY.md). */
  mode: "none" | "docker";
  /** Network-egress allowlist (host globs). DESIGN-ONLY — enforced by the container
   *  runtime once `mode: docker` lands. Defaults cover GitHub + Anthropic APIs. */
  egressAllowlist: string[];
  /** Container resource limits (DESIGN-ONLY). */
  memoryMb: number; // 0 = runtime default
  cpus: number; // 0 = runtime default
}

export interface WarrenConfig {
  profile: "chill" | "assertive";
  minSeverity: Severity; // findings below this are dropped
  // GitHub authentication + identity. SECRET-FREE: only the auth MODE and
  // non-secret identifiers (App id, installation id, bot login) plus the NAMES of
  // env vars / file paths holding secrets live here. The PAT, the App private key,
  // and the webhook secret are supplied via the environment / a mounted file.
  github: {
    // `pat` (default) = static Personal Access Token from GITHUB_TOKEN, posting as
    // a human. `app` = GitHub App identity: a signed RS256 JWT is exchanged for a
    // short-lived per-installation token; comments post as `<app-slug>[bot]`.
    auth: "pat" | "app";
    // app mode: the GitHub App's numeric App ID and the installation id to mint
    // tokens for. Not secrets. (Also overridable via GITHUB_APP_ID / _INSTALLATION_ID.)
    appId?: string;
    installationId?: string;
    // The bot's GitHub login (e.g. `warren[bot]`), used to recognize Warren's own
    // comments (sticky walkthrough upsert / resolve-on-fix / command scanner). When
    // unset in app mode it is resolved from `GET /app` at boot (best-effort).
    botLogin?: string;
    // Name of the env var holding the App private key PEM (default GITHUB_APP_PRIVATE_KEY).
    privateKeyEnv: string;
    // Path to a mounted file holding the App private key PEM (takes precedence over env).
    privateKeyPath?: string;
    // Name of the env var holding the webhook HMAC secret (default WARREN_WEBHOOK_SECRET).
    webhookSecretEnv: string;
  };
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
    // Author allowlist: when NON-EMPTY, only PRs whose author login is on this
    // list are auto-reviewed AND commented on (case-insensitive match). Empty
    // (default) = no author gating — every author is reviewed (legacy behavior).
    // Also gates @warren command-triggered reviews on the same PR-author policy.
    authors: string[];
    // Author DENYlist (case-insensitive): PRs by these logins are never
    // auto-reviewed AND their @warren commands are ignored. Complements `authors`;
    // deny wins over allow. Empty (default) = no denial. Use for noisy bots.
    denyAuthors: string[];
    // Skip pure version/release-churn PRs (title/branch/author heuristics +
    // release-only diff). Default true — see trigger/policy.ts for the built-ins.
    skipReleasePrs: boolean;
    // Additive custom release heuristics (on top of the built-in defaults).
    releaseTitlePatterns: string[]; // regex (case-insensitive) OR literal substring
    releaseBranchPatterns: string[];
    releaseAuthors: string[]; // extra login(s) treated as release bots
    // Label gating. A PR carrying ANY `skipLabels` label is skipped. When
    // `onlyLabels` is NON-EMPTY, a PR is auto-reviewed ONLY if it carries at
    // least one of them. Both empty except skipLabels defaults to [warren:skip].
    skipLabels: string[];
    onlyLabels: string[];
    // Ignore-pattern gates: a PR whose title/branch matches any of these is
    // skipped for AUTO review (explicit @warren commands still work). Empty default.
    skipTitlePatterns: string[];
    skipBranchPatterns: string[];
    // Command authorization by COMMENTER repo permission (GitHub author_association).
    // When NON-EMPTY, an @warren command is honored only if the commenter's
    // association is in this list (e.g. [OWNER, MEMBER, COLLABORATOR] → write access).
    // Empty (default) = no association gating (any commenter, legacy behavior).
    // Composes with the PR-author allow/deny gate. Case-insensitive.
    commandAssociations: string[];
  };
  // Per-repo review policy levers (cost/aggression). See review/policy.ts.
  review: {
    // Effort knob: maps to whether triage runs, verify on/off, and the reviewer
    // turn budget (a reasoning-effort proxy — herdctl has no native effort field).
    effort: "low" | "normal" | "high";
    // Soft budget ceilings. 0 = no cap. A PR exceeding either is skipped (logged)
    // rather than reviewed, so a giant/generated diff can't blow the token budget.
    maxFiles: number;
    maxTokens: number; // estimated from diff size (~chars/4)
    // SECURITY: how much host access the review agent gets on the UNTRUSTED checkout.
    //   • static  (default) — NO Bash; Read/Grep/Glob/Task only. PR code is never executed.
    //   • full              — Bash allowed (arbitrary exec). Only for fully-trusted repos.
    //   • trusted           — full for authors on `autoReview.authors`, else static.
    // See review/policy.ts (resolveExecution) + SECURITY.md.
    execution: ExecutionMode;
  };
  pathFilters: string[]; // gitignore-style; "!" prefix = exclude
  pathInstructions: Array<{ path: string; instructions: string }>;
  walkthrough: { sequenceDiagrams: boolean; poem: boolean };
  commandsAllowed: WarrenCommandKind[];
  models: { triage: string; review: string; verify: string };
  // On re-review, auto-resolve the GitHub review thread of a previously-posted
  // finding the author has since fixed (no longer detected). Default true.
  resolveOnFix: boolean;
  // Sandbox posture (SECURITY.md). `docker` is design-only today; `none` (default)
  // runs the agent in-process, boxed by the per-review `review.execution` tool policy.
  sandbox: SandboxConfig;
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
