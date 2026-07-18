// GithubPrTargetProvider (SPEC §3.6): materialize a `github-pr` target.
//
// Builds diff + changed files from the GitHubClient (full `getDiff`/`listFiles`, or an
// incremental `compare(sinceSha, headSha)` when `!full && sinceSha`), shallow-clones the
// repo at head SHA into `${dataDir}/checkouts/<key>` (reused + refetched across runs), and
// exposes `readFile`/`dispose`. All git runs go through the shared `runGit` helper.
//
// SECURITY: the checkout is UNTRUSTED PR code the review agent can Read/Grep (and, in
// `full` execution mode, Bash). The GitHub token is therefore NEVER embedded in the
// remote URL — `runGit` supplies it via a command-scoped credential helper reading the
// child's env, so no token-bearing string is written to the checkout's `.git/config`
// (a `cat .git/config` by the agent or a repo script yields nothing). See prepareCheckout.

import { existsSync } from "node:fs";
import { mkdir, readFile as fsReadFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitHubClient, PrFile } from "../github/index.js";
import type { GithubPrTarget, ReviewTarget } from "../types.js";
import { targetKey } from "../types.js";
import {
  buildDiffFromFiles,
  filterPath,
  filterUnifiedDiff,
  runGit,
  sanitizeKey,
} from "./target.js";
import type {
  MaterializedTarget,
  MaterializeOpts,
  ReviewTargetProvider,
  ReviewTargetProviderDeps,
} from "./target.js";

export class GithubPrTargetProvider implements ReviewTargetProvider {
  constructor(private readonly deps: ReviewTargetProviderDeps) {}

  async materialize(target: ReviewTarget, opts: MaterializeOpts): Promise<MaterializedTarget> {
    if (target.kind !== "github-pr") {
      throw new Error(`GithubPrTargetProvider cannot materialize kind "${target.kind}"`);
    }
    const t = target;
    const client = this.deps.clientFor?.(t) ?? null;
    if (!client) {
      throw new Error(`no GitHubClient available for ${targetKey(t)}`);
    }
    const filters = this.deps.pathFiltersFor?.(t) ?? this.deps.pathFilters ?? [];
    const keep = (p: string) => filterPath(p, filters);

    // Diff + files: incremental compare when we have a since-SHA, else the full PR diff.
    let diff: string;
    let files: PrFile[];
    let baseSha = t.baseSha;
    if (!opts.full && opts.sinceSha) {
      const cmp = await client.compare(t.repo, opts.sinceSha, t.headSha);
      files = cmp.files;
      diff = buildDiffFromFiles(files);
    } else {
      [diff, files] = await Promise.all([
        client.getDiff(t.repo, t.prNumber),
        client.listFiles(t.repo, t.prNumber),
      ]);
    }

    // Prune both by pathFilters.
    files = files.filter((f) => keep(f.path));
    diff = filterUnifiedDiff(diff, keep);

    // PR text for prompt context (title/body/author). Best-effort.
    let context = { title: "", body: "", author: "" };
    try {
      const pr = await client.getPr(t.repo, t.prNumber);
      context = { title: pr.title, body: pr.body, author: pr.author };
      baseSha = pr.baseSha || baseSha;
    } catch (err) {
      this.deps.logger?.debug?.(
        `github target: getPr failed (${err instanceof Error ? err.message : err})`,
      );
    }

    const checkoutDir = await this.prepareCheckout(t);

    return {
      kind: "github-pr",
      headSha: t.headSha,
      baseSha,
      diff,
      files,
      checkoutDir,
      context,
      readFile: (p: string) => fsReadFile(join(checkoutDir, p), "utf8"),
      dispose: async () => {
        await rm(checkoutDir, { recursive: true, force: true });
      },
    };
  }

  /**
   * Shallow clone (or reuse + refetch) the repo at head SHA into
   * `${dataDir}/checkouts/<sanitized-key>`. Delegates to the standalone
   * `prepareCheckout` helper so it can be unit-tested against a local remote.
   */
  private async prepareCheckout(t: GithubPrTarget): Promise<string> {
    const dir = join(this.deps.dataDir, "checkouts", sanitizeKey(targetKey(t)));
    const remoteUrl =
      this.deps.remoteUrlFor?.(t) ?? defaultGithubRemote(t.repo.owner, t.repo.name);
    return prepareCheckout({
      dir,
      remoteUrl,
      headSha: t.headSha,
      token: this.deps.githubToken ?? "",
    });
  }
}

/** Build the credential-FREE github remote URL. The token is supplied at fetch time by
 *  `runGit`'s credential helper, NOT embedded here — so it never persists in `.git/config`. */
export function defaultGithubRemote(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

export interface PrepareCheckoutOpts {
  /** Absolute checkout dir (created if absent). */
  dir: string;
  /** Credential-FREE remote URL. Never embed a token here. */
  remoteUrl: string;
  /** Commit to fetch + check out. */
  headSha: string;
  /** GitHub token, passed to `runGit` (credential-helper env) — never written to disk. */
  token?: string;
}

/**
 * Shallow clone (or reuse + refetch) a repo at `headSha` into `dir`, authenticating via
 * `runGit`'s command-scoped credential helper. Guarantees no token-bearing string is
 * written to `dir/.git/config`: the remote URL is credential-free, and on REUSE we
 * `remote set-url` back to the credential-free URL — which also SCRUBS any token a prior
 * (pre-hardening) run may have persisted. Returns the checkout dir.
 */
export async function prepareCheckout(opts: PrepareCheckoutOpts): Promise<string> {
  const { dir, remoteUrl, headSha } = opts;
  const token = opts.token ?? "";
  await mkdir(dir, { recursive: true });
  if (existsSync(join(dir, ".git"))) {
    // Reuse: reset the remote URL to the credential-free URL (also scrubs any legacy
    // token a pre-hardening checkout embedded), then refetch head.
    await runGit(["remote", "set-url", "origin", remoteUrl], { cwd: dir });
  } else {
    await runGit(["init", "--quiet"], { cwd: dir });
    await runGit(["remote", "add", "origin", remoteUrl], { cwd: dir });
  }
  await runGit(["fetch", "--depth", "1", "--quiet", "origin", headSha], { cwd: dir, token });
  await runGit(["checkout", "--quiet", "--force", headSha], { cwd: dir });
  return dir;
}
