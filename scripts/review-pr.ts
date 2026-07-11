/**
 * review-pr.ts — one-shot: run Warren's full review pipeline against a real
 * GitHub PR and capture the ReviewResult locally (never posts).
 *
 * Usage:
 *   env -u NODE_ENV npx tsx scripts/review-pr.ts <owner/repo> <prNumber> [outDir]
 *
 * Reads hit the live GitHub API (needs GITHUB_TOKEN). Writes are DRY-RUN only:
 * WARREN_LIVE must be unset/0 so the "post" is captured to the DryRunSink. The
 * ReviewResult returned by pipeline.run(...) is the source of truth; we write it
 * to <outDir>/<repo>-<n>.json and a rendered <outDir>/<repo>-<n>.md.
 */
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as path from "node:path";

import { createContainer } from "../src/container.js";
import { buildSuggestionBlock } from "../src/github/index.js";
import type { Finding, GithubPrTarget, ReviewEvent, ReviewResult } from "../src/types.js";

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${errOut || err.message}`));
      else resolve(out);
    });
  });
}

async function main() {
  const [slug, prArg, outArg] = process.argv.slice(2);
  if (!slug || !prArg || !slug.includes("/")) {
    console.error("usage: review-pr.ts <owner/repo> <prNumber> [outDir]");
    process.exit(2);
  }
  const [owner, name] = slug.split("/");
  const prNumber = Number.parseInt(prArg, 10);
  const outDir =
    outArg ?? "/var/lib/paddock/projects/coderabbit/research/realworld";

  // Resolve head/base SHAs + base ref from the GitHub CLI (already authed).
  const meta = JSON.parse(
    await sh("gh", [
      "pr", "view", String(prNumber),
      "--repo", slug,
      "--json", "headRefOid,baseRefOid,baseRefName,title,additions,deletions,changedFiles",
    ]),
  ) as {
    headRefOid: string;
    baseRefOid: string;
    baseRefName: string;
    title: string;
    additions: number;
    deletions: number;
    changedFiles: number;
  };

  const target: GithubPrTarget = {
    kind: "github-pr",
    repo: { owner, name },
    prNumber,
    headSha: meta.headRefOid,
    baseSha: meta.baseRefOid,
    baseRef: meta.baseRefName,
  };

  // Force dry-run + isolated data dir so we never collide with the live `pm warren`.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WARREN_LIVE: "0",
    WARREN_DATA_DIR:
      process.env.WARREN_DATA_DIR || "/tmp/warren-eval-data",
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  };
  if (env.WARREN_LIVE !== "0") throw new Error("refusing to run: WARREN_LIVE not 0");

  const app = await createContainer({ env });
  const event: ReviewEvent = {
    target,
    reason: "manual",
    full: true,
    receivedAt: new Date().toISOString(),
  };

  const started = Date.now();
  console.error(`[review-pr] reviewing ${slug}#${prNumber} (${meta.title})`);
  let result: ReviewResult;
  try {
    result = await app.pipeline.run(event);
  } finally {
    await app.stop().catch(() => {});
  }
  const wallMs = Date.now() - started;

  await fs.mkdir(outDir, { recursive: true });
  const stem = `${name}-${prNumber}`;
  const jsonPath = path.join(outDir, `${stem}.json`);
  const mdPath = path.join(outDir, `${stem}.md`);
  await fs.writeFile(
    jsonPath,
    JSON.stringify({ meta, wallMs, result }, null, 2),
    "utf8",
  );
  await fs.writeFile(mdPath, renderReport(slug, prNumber, meta, wallMs, result), "utf8");

  console.error(
    `[review-pr] ${slug}#${prNumber}: raw=${result.stats.findingsRaw} ` +
      `verified=${result.stats.findingsVerified} posted=${result.stats.findingsPosted} ` +
      `wall=${(wallMs / 1000).toFixed(1)}s → ${mdPath}`,
  );
}

function renderReport(
  slug: string,
  prNumber: number,
  meta: { title: string; additions: number; deletions: number; changedFiles: number },
  wallMs: number,
  r: ReviewResult,
): string {
  const L: string[] = [
    `# Warren review — ${slug}#${prNumber}`,
    "",
    `**${meta.title}**`,
    "",
    `${meta.changedFiles} files, +${meta.additions}/-${meta.deletions} · ` +
      `wall ${(wallMs / 1000).toFixed(1)}s · model ${r.stats.reviewModel}`,
    "",
    `raw=${r.stats.findingsRaw} verified=${r.stats.findingsVerified} ` +
      `posted=${r.stats.findingsPosted} filesReviewed=${r.stats.filesReviewed}`,
    "",
    "## Summary",
    "",
    r.summary || "_(none)_",
    "",
    "## Walkthrough",
    "",
    r.walkthrough || "_(none)_",
    "",
    `## Findings (${r.findings.length})`,
  ];
  if (r.findings.length === 0) L.push("", "_(no findings after gate)_");
  for (const f of r.findings) L.push("", renderFinding(f));
  return `${L.join("\n")}\n`;
}

function renderFinding(f: Finding): string {
  const parts = [
    `### ${f.severity.toUpperCase()} · ${f.category} — ${f.title}`,
    `\`${f.path}:${f.line}${f.endLine ? `-${f.endLine}` : ""}\` (${f.side}) · ` +
      `confidence ${f.confidence.toFixed(2)} · verified ${f.verified}`,
    "",
    f.body,
  ];
  if (f.suggestion) parts.push("", buildSuggestionBlock(f.suggestion));
  return parts.join("\n");
}

main().catch((err) => {
  console.error("[review-pr] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
