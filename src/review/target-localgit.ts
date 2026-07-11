// LocalGitTargetProvider (SPEC §3.6): materialize a `local-git` target.
//
// Reviews the diff between two refs in an EXISTING local repo, with no GitHub PR. This
// is Warren's testbed (`main..pr/seeded-issues`). It resolves both refs to SHAs via
// `git rev-parse`, builds the diff with `git diff <base>..<head>`, derives the changed
// file list from `--name-status` + `--numstat`, and reads files at head via `git show`.
//
// checkoutDir ASSUMPTION: we hand back `repoDir` directly (no temp worktree). The source
// working tree is left untouched — we never check anything out. `readFile` uses
// `git show <headSha>:<path>`, so file reads are head-accurate REGARDLESS of whatever
// branch/worktree state repoDir currently has. (A future refinement could add a
// `git worktree` at head; repoDir-direct is the documented simplest form.)

import type { PrFile } from "../github/index.js";
import type { LocalGitTarget, ReviewTarget } from "../types.js";
import { filterPath, filterUnifiedDiff, runGit, splitDiffByFile } from "./target.js";
import type {
  MaterializedTarget,
  MaterializeOpts,
  ReviewTargetProvider,
  ReviewTargetProviderDeps,
} from "./target.js";

export class LocalGitTargetProvider implements ReviewTargetProvider {
  constructor(private readonly deps: ReviewTargetProviderDeps) {}

  async materialize(target: ReviewTarget, _opts: MaterializeOpts): Promise<MaterializedTarget> {
    if (target.kind !== "local-git") {
      throw new Error(`LocalGitTargetProvider cannot materialize kind "${target.kind}"`);
    }
    const t = target;
    const cwd = t.repoDir;
    const filters = this.deps.pathFiltersFor?.(t) ?? this.deps.pathFilters ?? [];
    const keep = (p: string) => filterPath(p, filters);

    // Resolve refs → SHAs (local-git resolves at provider time, per targetHeadSha()).
    const [baseSha, headSha] = await Promise.all([
      this.revParse(cwd, t.baseRef),
      this.revParse(cwd, t.headRef),
    ]);
    const range = `${baseSha}..${headSha}`;

    // Diff + changed files.
    let diff = await runGit(["diff", range], { cwd });
    const [numstat, nameStatus] = await Promise.all([
      runGit(["diff", "--numstat", range], { cwd }),
      runGit(["diff", "--name-status", range], { cwd }),
    ]);
    const stats = parseNumstat(numstat);
    const patches = new Map(splitDiffByFile(diff).map((p) => [p.path, p.patch]));
    let files: PrFile[] = parseNameStatus(nameStatus).map(({ path, status }) => {
      const s = stats.get(path);
      return {
        path,
        status,
        additions: s?.additions ?? 0,
        deletions: s?.deletions ?? 0,
        patch: patches.get(path),
      };
    });

    // Prune both by pathFilters.
    files = files.filter((f) => keep(f.path));
    diff = filterUnifiedDiff(diff, keep);

    const context = await this.deriveContext(cwd, t, baseSha, headSha);

    return {
      kind: "local-git",
      headSha,
      baseSha,
      diff,
      files,
      checkoutDir: cwd,
      context,
      readFile: (p: string) => runGit(["show", `${headSha}:${p}`], { cwd }),
      // repoDir is not ours to remove; nothing temp was created.
      dispose: async () => {},
    };
  }

  private async revParse(cwd: string, ref: string): Promise<string> {
    return (await runGit(["rev-parse", ref], { cwd })).trim();
  }

  /** Synthesize PR-like context (title/body/author) from commit metadata + label. */
  private async deriveContext(
    cwd: string,
    t: LocalGitTarget,
    baseSha: string,
    headSha: string,
  ): Promise<{ title: string; body: string; author: string }> {
    let body = "";
    let author = "";
    try {
      const log = await runGit(
        ["log", "--format=- %s", `${baseSha}..${headSha}`],
        { cwd },
      );
      body = log.trim() ? `Commits in ${t.baseRef}..${t.headRef}:\n${log.trim()}` : "";
      author = (await runGit(["log", "-1", "--format=%an", headSha], { cwd })).trim();
    } catch {
      /* best-effort */
    }
    return { title: t.label, body, author };
  }
}

// ─────────────────────────── numstat / name-status parsers ───────────────────────────

/** `git diff --numstat`: "<add>\t<del>\t<path>" (binary → "-"; rename → "old => new"). */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw] = parts;
    const path = renameFinalPath(parts.slice(2).join("\t"));
    map.set(path, {
      additions: addRaw === "-" ? 0 : Number(addRaw) || 0,
      deletions: delRaw === "-" ? 0 : Number(delRaw) || 0,
    });
  }
  return map;
}

/** `git diff --name-status`: "<STATUS>\t<path>" (rename: "R100\told\tnew"). */
function parseNameStatus(out: string): Array<{ path: string; status: string }> {
  const rows: Array<{ path: string; status: string }> = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const code = parts[0][0];
    // For renames/copies the destination path is the LAST field.
    const path = parts[parts.length - 1];
    rows.push({ path, status: STATUS_MAP[code] ?? "modified" });
  }
  return rows;
}

const STATUS_MAP: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "modified",
  U: "modified",
};

/** Collapse a numstat rename path ("old => new" or "dir/{old => new}") to the new path. */
function renameFinalPath(p: string): string {
  if (!p.includes(" => ")) return p;
  // Brace form: "dir/{old => new}/file" → keep the "new" side.
  const collapsed = p.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1");
  if (!collapsed.includes(" => ")) return collapsed;
  // Plain form: "old => new".
  return collapsed.split(" => ").pop() ?? collapsed;
}
