// Review-target providers (SPEC §3.6).
//
// A ReviewTargetProvider is the ONLY module that knows target-kind mechanics, so
// the pipeline and the review agent stay target-agnostic. Given a ReviewTarget it
// `materialize()`s everything a review needs:
//
//   • the unified diff (base..head), already pruned by pathFilters       (getUnifiedDiff)
//   • the changed-file list with per-file patch + numstat status         (getChangedFiles)
//   • the resolved base/head SHAs (local-git resolves its refs here)      (getBaseHeadShas)
//   • a real working checkout at head SHA the agent can Read/Grep/Bash    (prepareCheckout)
//   • readFile(path) to pull any file at head from that checkout
//
// The five task-level capabilities above are surfaced as fields of the returned
// `MaterializedTarget` (the frozen seam other Wave-B/C modules — pipeline.ts,
// mcp/github-pr.ts — call). Two concrete impls live in target-github.ts and
// target-localgit.ts; `createReviewTargetProvider` dispatches by `target.kind`.

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { PrFile } from "../github/index.js";
import type { GitHubClient } from "../github/index.js";
import type { Logger, ReviewTarget } from "../types.js";

// ─────────────────────────── Seam types ───────────────────────────

/**
 * The fully-materialized view of a review target. Every field is a resolved,
 * self-contained artifact — no credentials, no live handles the agent could abuse.
 *
 * `diff`/`files` are the unified diff and changed-file list, both already pruned by
 * `pathFilters`. `checkoutDir` is an absolute path to a working tree at `headSha`
 * (the reviewer agent's `working_directory`), so the agent sees the REAL code around
 * the diff, not just the patch. `readFile` reads any repo-relative path at head from
 * that checkout. `context` is PR text (title/body/author) for prompt context —
 * UNTRUSTED (see prompts.ts). `dispose` releases any temp worktree/clone; idempotent.
 */
export interface MaterializedTarget {
  kind: ReviewTarget["kind"];
  /** Resolved head SHA (local-git resolves `headRef` here). */
  headSha: string;
  /** Resolved base SHA (local-git resolves `baseRef` here). */
  baseSha: string;
  /** Unified diff (base..head), already filtered by pathFilters. */
  diff: string;
  /** Changed files with per-file patch + status, already filtered by pathFilters. */
  files: PrFile[];
  /** Absolute path to a working checkout at head SHA (the agent's cwd). */
  checkoutDir: string;
  /** PR text for prompt context. For local-git: derived from commit messages/label. */
  context: { title: string; body: string; author: string };
  /** Read any file at head from the checkout (path repo-relative). */
  readFile(path: string): Promise<string>;
  /** Release temp checkouts/worktrees. Idempotent. */
  dispose(): Promise<void>;
}

export interface MaterializeOpts {
  /** True = ignore `sinceSha`, review the whole diff. */
  full: boolean;
  /** Last-reviewed head SHA; enables incremental (compare) diffs. "" = none. */
  sinceSha: string;
}

/**
 * Materialize a review target: produce diff + a working checkout + file reads.
 * The pipeline calls exactly this; nothing downstream branches on `target.kind`.
 */
export interface ReviewTargetProvider {
  materialize(target: ReviewTarget, opts: MaterializeOpts): Promise<MaterializedTarget>;
}

/**
 * Deps shared by both concrete providers. `clientFor`/`githubToken` are only used
 * by the github-pr impl; `pathFiltersFor`/`pathFilters` supply the per-repo filter
 * list (the frozen `materialize` signature carries no config, so filters flow in here).
 */
export interface ReviewTargetProviderDeps {
  /** Root data dir; checkouts land under `${dataDir}/checkouts/<key>`. */
  dataDir: string;
  logger?: Logger;
  /** Resolve the GitHubClient for a github-pr target (null/absent for local-git). */
  clientFor?: (t: ReviewTarget) => GitHubClient | null;
  /** GitHub token used ONLY to build the clone remote URL. NEVER logged. */
  githubToken?: string;
  /** Per-target path filters (gitignore-style, `!` = exclude). Overrides `pathFilters`. */
  pathFiltersFor?: (t: ReviewTarget) => string[];
  /** Fallback path filters when `pathFiltersFor` is absent. */
  pathFilters?: string[];
}

// ─────────────────────────── Factory ───────────────────────────

// Imported here (not re-exported) purely for the dispatcher. Concrete providers
// import the helpers below from this module; the function declarations are hoisted,
// so the (harmless) ESM cycle resolves cleanly.
import { GithubPrTargetProvider } from "./target-github.js";
import { LocalGitTargetProvider } from "./target-localgit.js";

/** Build a provider that dispatches to the github-pr or local-git impl by kind. */
export function createReviewTargetProvider(
  deps: ReviewTargetProviderDeps,
): ReviewTargetProvider {
  const github = new GithubPrTargetProvider(deps);
  const localGit = new LocalGitTargetProvider(deps);
  return {
    materialize(target, opts) {
      return target.kind === "github-pr"
        ? github.materialize(target, opts)
        : localGit.materialize(target, opts);
    },
  };
}

// ─────────────────────────── Shared helpers ───────────────────────────

/**
 * Run `git` with argv (no shell), returning stdout. `token`, when given, is scrubbed
 * from any error text so a credential-bearing remote URL never leaks into logs/throws.
 */
export function runGit(
  args: string[],
  opts: { cwd?: string; token?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const scrub = (s: string) =>
            opts.token && opts.token.length > 0 ? s.split(opts.token).join("***") : s;
          reject(
            new Error(
              `git ${scrub(args.join(" "))} failed: ${scrub(String(stderr || err.message))}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Filesystem/agent-safe key sanitizer (non-alnum → `_`), matching the state store. */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "_");
}

/** Translate a gitignore-ish glob to an anchored RegExp (`**`, `*`, `?` supported). */
export function globToRegExp(glob: string): RegExp {
  let g = glob;
  // Placeholders so regex-escaping doesn't touch the glob metachars.
  g = g.replace(/\*\*\//g, ""); // **/  → optional leading dirs
  g = g.replace(/\*\*/g, ""); // **   → anything
  g = g.replace(/\*/g, ""); // *    → non-slash run
  g = g.replace(/\?/g, ""); // ?    → single non-slash
  g = g.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  g = g.replace(//g, "(?:.*/)?");
  g = g.replace(//g, ".*");
  g = g.replace(//g, "[^/]*");
  g = g.replace(//g, "[^/]");
  return new RegExp(`^${g}$`);
}

/** True if a repo-relative path matches a glob (basename-matched for slash-free globs). */
export function pathMatchesGlob(path: string, glob: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(path)) return true;
  return !glob.includes("/") && re.test(basename(path));
}

/**
 * Apply gitignore-style filters. Rules: if any positive (non-`!`) patterns exist a
 * path must match at least one; a path matching any `!`-prefixed pattern is excluded.
 * Default (no filters, or only negatives) → included unless excluded.
 */
export function filterPath(path: string, filters: string[]): boolean {
  const positives = filters.filter((f) => !f.startsWith("!"));
  const negatives = filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
  let included = positives.length === 0 || positives.some((p) => pathMatchesGlob(path, p));
  if (included && negatives.some((n) => pathMatchesGlob(path, n))) included = false;
  return included;
}

/** Drop whole file sections from a unified diff whose path fails `keep`. */
export function filterUnifiedDiff(diff: string, keep: (path: string) => boolean): string {
  if (!diff) return diff;
  const out: string[] = [];
  let keeping = true;
  let sawHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      sawHeader = true;
      const m = / b\/(.+)$/.exec(line);
      keeping = keep(m ? m[1] : "");
    }
    if (!sawHeader || keeping) out.push(line);
  }
  return out.join("\n");
}

/** Split a full unified diff into per-file `{ path, patch }` (patch = from first `@@`). */
export function splitDiffByFile(diff: string): Array<{ path: string; patch: string }> {
  const files: Array<{ path: string; patch: string }> = [];
  let path = "";
  let bodyLines: string[] | null = null;
  let inPatch = false;
  const flush = () => {
    if (path && bodyLines) files.push({ path, patch: bodyLines.join("\n") });
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      const m = / b\/(.+)$/.exec(line);
      path = m ? m[1] : "";
      bodyLines = null;
      inPatch = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inPatch = true;
      if (!bodyLines) bodyLines = [];
    }
    if (inPatch && bodyLines) bodyLines.push(line);
  }
  flush();
  return files;
}

/** Reconstruct a unified diff from PrFile patches (used for incremental/compare diffs). */
export function buildDiffFromFiles(files: PrFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    parts.push(
      `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`,
    );
  }
  return parts.length ? `${parts.join("\n")}\n` : "";
}
