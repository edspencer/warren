// GithubPrTargetProvider (SPEC §3.6): materialize a `github-pr` target.
//
// Builds diff + changed files from the GitHubClient (full `getDiff`/`listFiles`, or an
// incremental `compare(sinceSha, headSha)` when `!full && sinceSha`), shallow-clones the
// repo at head SHA into `${dataDir}/checkouts/<key>` (reused + refetched across runs), and
// exposes `readFile`/`dispose`. All git runs go through the shared `runGit` helper, which
// SCRUBS the token from any error text — the credential-bearing remote URL never leaks.

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
   * `${dataDir}/checkouts/<sanitized-key>`. The token is embedded only in the remote
   * URL and never logged (runGit scrubs it from errors).
   */
  private async prepareCheckout(t: GithubPrTarget): Promise<string> {
    const dir = join(this.deps.dataDir, "checkouts", sanitizeKey(targetKey(t)));
    const token = this.deps.githubToken ?? "";
    const cred = token ? `x-access-token:${token}@` : "";
    const remote = `https://${cred}github.com/${t.repo.owner}/${t.repo.name}.git`;

    await mkdir(dir, { recursive: true });
    if (existsSync(join(dir, ".git"))) {
      // Reuse: refresh the remote URL (token may have rotated) then refetch head.
      await runGit(["remote", "set-url", "origin", remote], { cwd: dir, token });
    } else {
      await runGit(["init", "--quiet"], { cwd: dir, token });
      await runGit(["remote", "add", "origin", remote], { cwd: dir, token });
    }
    await runGit(["fetch", "--depth", "1", "--quiet", "origin", t.headSha], { cwd: dir, token });
    await runGit(["checkout", "--quiet", "--force", t.headSha], { cwd: dir, token });
    return dir;
  }
}
