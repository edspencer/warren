import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWarrenConfig,
  defaultWarrenConfig,
  resolveRepoConfig,
} from "../src/config/load.js";
import { WarrenConfigZ } from "../src/config/schema.js";
import { readEnv, redactedEnv } from "../src/config/env.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "warren-cfg-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("config schema + load", () => {
  it("applies all defaults when the file is absent", async () => {
    const cfg = await loadWarrenConfig(join(dir, "does-not-exist.yaml"));
    expect(cfg.profile).toBe("chill");
    expect(cfg.minSeverity).toBe("low");
    expect(cfg.trigger.mode).toBe("poll");
    expect(cfg.trigger.pollIntervalMs).toBe(60_000); // "60s"
    expect(cfg.autoReview.enabled).toBe(true);
    expect(cfg.autoReview.baseBranches).toEqual(["main"]);
    expect(cfg.autoReview.authors).toEqual([]); // no author gating by default
    // #26 filter defaults
    expect(cfg.autoReview.denyAuthors).toEqual([]);
    expect(cfg.autoReview.skipReleasePrs).toBe(true); // skip release PRs by default
    expect(cfg.autoReview.skipLabels).toEqual(["warren:skip"]);
    expect(cfg.autoReview.onlyLabels).toEqual([]);
    expect(cfg.autoReview.releaseTitlePatterns).toEqual([]);
    // #26 review policy defaults (no cap, normal effort)
    expect(cfg.review.effort).toBe("normal");
    expect(cfg.review.maxFiles).toBe(0);
    expect(cfg.review.maxTokens).toBe(0);
    expect(cfg.live).toBe(false); // dry-run default
    expect(cfg.concurrency).toBe(3);
    expect(cfg.repos).toEqual([]);
  });

  it("defaultWarrenConfig() equals an empty-file load", async () => {
    const a = defaultWarrenConfig();
    const b = await loadWarrenConfig(join(dir, "nope.yaml"));
    expect(a).toEqual(b);
  });

  it("parses a sample .warren.yaml (snake_case -> camelCase)", async () => {
    const yaml = [
      "profile: assertive",
      "min_severity: high",
      "trigger:",
      "  mode: poll",
      "  poll_interval: 5m",
      "auto_review:",
      "  drafts: true",
      "  base_branches: [main, develop]",
      "  authors: [edspencer, octocat]",
      "walkthrough:",
      "  poem: true",
      "repos:",
      "  - local_git:",
      "      repo_dir: /tmp/repo",
      "      base_ref: main",
      "      head_ref: pr/seeded",
      "      label: local:seeded",
      "    overrides:",
      "      min_severity: low",
      "",
    ].join("\n");
    const path = join(dir, "sample.warren.yaml");
    await writeFile(path, yaml, "utf8");

    const cfg = await loadWarrenConfig(path);
    expect(cfg.profile).toBe("assertive");
    expect(cfg.minSeverity).toBe("high");
    expect(cfg.trigger.pollIntervalMs).toBe(5 * 60_000);
    expect(cfg.autoReview.drafts).toBe(true);
    expect(cfg.autoReview.baseBranches).toEqual(["main", "develop"]);
    expect(cfg.autoReview.authors).toEqual(["edspencer", "octocat"]);
    expect(cfg.walkthrough.poem).toBe(true);
    expect(cfg.repos).toHaveLength(1);
    expect(cfg.repos[0].localGit).toEqual({
      repoDir: "/tmp/repo",
      baseRef: "main",
      headRef: "pr/seeded",
      label: "local:seeded",
    });
    // overrides mapped snake -> camel
    expect(cfg.repos[0].overrides).toEqual({ minSeverity: "low" });

    // repo override wins over server config
    const resolved = resolveRepoConfig(cfg, cfg.repos[0]);
    expect(resolved.minSeverity).toBe("low");
    expect(resolved.profile).toBe("assertive"); // inherited from server
  });

  it("parses #26 trigger filters + review policy (snake -> camel) with per-repo override", async () => {
    const yaml = [
      "auto_review:",
      "  deny_authors: [noisybot]",
      "  skip_release_prs: false",
      "  release_title_patterns: ['^chore: bump']",
      "  skip_labels: [wip, warren:skip]",
      "  only_labels: [needs-review]",
      "  skip_branch_patterns: ['^wip/']",
      "review:",
      "  effort: high",
      "  max_files: 40",
      "  max_tokens: 120000",
      "repos:",
      "  - github: { owner: acme, name: widgets }",
      "    overrides:",
      "      review:",
      "        effort: low",
      "",
    ].join("\n");
    const p = join(dir, "filters.warren.yaml");
    await writeFile(p, yaml, "utf8");

    const cfg = await loadWarrenConfig(p);
    expect(cfg.autoReview.denyAuthors).toEqual(["noisybot"]);
    expect(cfg.autoReview.skipReleasePrs).toBe(false);
    expect(cfg.autoReview.releaseTitlePatterns).toEqual(["^chore: bump"]);
    expect(cfg.autoReview.skipLabels).toEqual(["wip", "warren:skip"]);
    expect(cfg.autoReview.onlyLabels).toEqual(["needs-review"]);
    expect(cfg.autoReview.skipBranchPatterns).toEqual(["^wip/"]);
    expect(cfg.review.effort).toBe("high");
    expect(cfg.review.maxFiles).toBe(40);
    expect(cfg.review.maxTokens).toBe(120000);

    // per-repo override deep-merges: effort=low wins, but server max_files persists.
    const resolved = resolveRepoConfig(cfg, cfg.repos[0]);
    expect(resolved.review.effort).toBe("low");
    expect(resolved.review.maxFiles).toBe(40);
    expect(resolved.autoReview.onlyLabels).toEqual(["needs-review"]);
  });

  it("rejects an invalid review.effort value", () => {
    expect(() => WarrenConfigZ.parse({ review: { effort: "ludicrous" } })).toThrow();
  });

  it("rejects an invalid enum value", () => {
    expect(() => WarrenConfigZ.parse({ min_severity: "catastrophic" })).toThrow();
    expect(() => WarrenConfigZ.parse({ profile: "spicy" })).toThrow();
    expect(() => WarrenConfigZ.parse({ trigger: { mode: "carrier-pigeon" } })).toThrow();
  });

  it("rejects a repo without exactly one of github|local_git", () => {
    expect(() => WarrenConfigZ.parse({ repos: [{}] })).toThrow();
    expect(() =>
      WarrenConfigZ.parse({
        repos: [{ github: { owner: "o", name: "n" }, local_git: { repo_dir: "/r", base_ref: "a", head_ref: "b", label: "l" } }],
      }),
    ).toThrow();
  });

  it("uses the corrected model-id defaults", () => {
    const cfg = defaultWarrenConfig();
    expect(cfg.models.review).toBe("claude-opus-4-8");
    expect(cfg.models.triage).toBe("claude-haiku-4-5-20251001");
    expect(cfg.models.verify).toBe("claude-haiku-4-5-20251001");
  });
});

describe("env", () => {
  it("applies defaults for an empty environment", () => {
    const env = readEnv({});
    expect(env.runtime).toBe("cli");
    expect(env.live).toBe(false);
    expect(env.host).toBe("0.0.0.0");
    expect(env.port).toBe(5000);
    expect(env.repos).toEqual([]);
    expect(env.dataDir).toBe("./data");
    expect(env.githubToken).toBeUndefined();
  });

  it("parses WARREN_LIVE, WARREN_REPOS csv, and PORT", () => {
    const env = readEnv({
      WARREN_LIVE: "1",
      WARREN_REPOS: "acme/app, acme/lib ",
      PORT: "5123",
      GITHUB_TOKEN: "secret-token",
    });
    expect(env.live).toBe(true);
    expect(env.repos).toEqual(["acme/app", "acme/lib"]);
    expect(env.port).toBe(5123);
    expect(env.githubToken).toBe("secret-token");
  });

  it("redactedEnv() never exposes secret values", () => {
    const env = readEnv({ GITHUB_TOKEN: "secret-token", ANTHROPIC_API_KEY: "sk-xxx" });
    const red = redactedEnv(env);
    expect(red.hasGithubToken).toBe(true);
    expect(red.hasAnthropicApiKey).toBe(true);
    expect(JSON.stringify(red)).not.toContain("secret-token");
    expect(JSON.stringify(red)).not.toContain("sk-xxx");
  });

  it("WARREN_LIVE env overrides config.live via loadWarrenConfig", async () => {
    const env = readEnv({ WARREN_LIVE: "true" });
    const cfg = await loadWarrenConfig(join(dir, "absent.yaml"), env);
    expect(cfg.live).toBe(true);
  });
});
