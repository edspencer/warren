import { describe, it, expect } from "vitest";
import type { WarrenConfig } from "../src/types.js";
import {
  autoReviewDecision,
  commandAllowed,
  isAuthorAllowed,
  isAuthorDenied,
  isReleasePr,
  labelGateAllows,
  matchesAnyPattern,
  type PrLike,
} from "../src/trigger/policy.js";
import {
  budgetSkipReason,
  effortSettings,
  estimateTokens,
  isReleaseDiff,
  isReleasePath,
} from "../src/review/policy.js";

type AutoReview = WarrenConfig["autoReview"];

/** Default (schema-equivalent) autoReview block; override per test. */
function ar(over: Partial<AutoReview> = {}): AutoReview {
  return {
    enabled: true,
    drafts: false,
    baseBranches: ["main"],
    authors: [],
    denyAuthors: [],
    skipReleasePrs: true,
    releaseTitlePatterns: [],
    releaseBranchPatterns: [],
    releaseAuthors: [],
    skipLabels: ["warren:skip"],
    onlyLabels: [],
    skipTitlePatterns: [],
    skipBranchPatterns: [],
    ...over,
  };
}

function prLike(over: Partial<PrLike> = {}): PrLike {
  return { title: "Add feature", headRef: "feature", author: "alice", labels: [], ...over };
}

describe("trigger/policy — author gates", () => {
  it("allowlist: empty allows everyone; non-empty is case-insensitive", () => {
    expect(isAuthorAllowed("anyone", [])).toBe(true);
    expect(isAuthorAllowed("Alice", ["alice"])).toBe(true);
    expect(isAuthorAllowed("mallory", ["alice"])).toBe(false);
    expect(isAuthorAllowed(undefined, ["alice"])).toBe(false);
  });

  it("denylist: matches case-insensitively; empty denies no one", () => {
    expect(isAuthorDenied("NoisyBot", ["noisybot"])).toBe(true);
    expect(isAuthorDenied("alice", ["noisybot"])).toBe(false);
    expect(isAuthorDenied("alice", [])).toBe(false);
  });
});

describe("trigger/policy — label gate", () => {
  it("skip labels block; only labels require membership", () => {
    expect(labelGateAllows([], [], [])).toBe(true);
    expect(labelGateAllows(["warren:skip"], ["warren:skip"], [])).toBe(false);
    expect(labelGateAllows(["WARREN:SKIP"], ["warren:skip"], [])).toBe(false); // case-insensitive
    expect(labelGateAllows(["bug"], [], ["needs-review"])).toBe(false); // missing required
    expect(labelGateAllows(["needs-review"], [], ["needs-review"])).toBe(true);
    // skip wins over only
    expect(labelGateAllows(["needs-review", "warren:skip"], ["warren:skip"], ["needs-review"])).toBe(false);
  });
});

describe("trigger/policy — pattern matching + release heuristic", () => {
  it("matchesAnyPattern: regex + literal fallback for bad regex", () => {
    expect(matchesAnyPattern("chore: version packages", ["^chore:\\s*version"])).toBe(true);
    expect(matchesAnyPattern("Add feature", ["^chore:"])).toBe(false);
    expect(matchesAnyPattern("weird (unclosed", ["(unclosed"])).toBe(true); // bad regex -> substring
    expect(matchesAnyPattern("x", [])).toBe(false);
  });

  it("isReleasePr fires on built-in title/branch/author signals", () => {
    expect(isReleasePr(prLike({ title: "chore: version packages" }), ar())).toBe(true);
    expect(isReleasePr(prLike({ headRef: "changeset-release/main" }), ar())).toBe(true);
    expect(isReleasePr(prLike({ author: "github-actions[bot]" }), ar())).toBe(true);
    expect(isReleasePr(prLike({ title: "Release v1.2.0" }), ar())).toBe(true);
    expect(isReleasePr(prLike(), ar())).toBe(false); // ordinary PR
  });

  it("isReleasePr honors additive custom patterns/authors", () => {
    expect(isReleasePr(prLike({ title: "chore: bump deps" }), ar({ releaseTitlePatterns: ["^chore: bump"] }))).toBe(true);
    expect(isReleasePr(prLike({ author: "myrelease-bot" }), ar({ releaseAuthors: ["myrelease-bot"] }))).toBe(true);
  });
});

describe("trigger/policy — combined decisions", () => {
  it("autoReviewDecision: default config allows an ordinary PR", () => {
    expect(autoReviewDecision(prLike(), ar()).allow).toBe(true);
  });

  it("autoReviewDecision: each gate blocks with a reason", () => {
    expect(autoReviewDecision(prLike({ author: "noisybot" }), ar({ denyAuthors: ["noisybot"] })).allow).toBe(false);
    expect(autoReviewDecision(prLike({ author: "mallory" }), ar({ authors: ["alice"] })).allow).toBe(false);
    expect(autoReviewDecision(prLike({ labels: ["warren:skip"] }), ar()).allow).toBe(false);
    expect(autoReviewDecision(prLike({ title: "WIP: draft idea" }), ar({ skipTitlePatterns: ["^wip:"] })).allow).toBe(false);
    expect(autoReviewDecision(prLike({ headRef: "wip/foo" }), ar({ skipBranchPatterns: ["^wip/"] })).allow).toBe(false);
    expect(autoReviewDecision(prLike({ title: "chore: version packages" }), ar()).allow).toBe(false);
  });

  it("autoReviewDecision: skip_release_prs=false lets a release PR through", () => {
    expect(autoReviewDecision(prLike({ title: "chore: version packages" }), ar({ skipReleasePrs: false })).allow).toBe(true);
  });

  it("commandAllowed: gated on author/label only, NOT release/ignore heuristics", () => {
    // A release-looking PR still accepts an explicit command.
    expect(commandAllowed(prLike({ title: "chore: version packages" }), ar())).toBe(true);
    // Denied author / skip label still block commands.
    expect(commandAllowed(prLike({ author: "noisybot" }), ar({ denyAuthors: ["noisybot"] }))).toBe(false);
    expect(commandAllowed(prLike({ labels: ["warren:skip"] }), ar())).toBe(false);
    // Non-allowlisted author blocked.
    expect(commandAllowed(prLike({ author: "mallory" }), ar({ authors: ["alice"] }))).toBe(false);
  });
});

describe("review/policy — release diff", () => {
  it("isReleasePath matches lockfiles/CHANGELOG/.changeset", () => {
    for (const p of [
      "CHANGELOG.md",
      "packages/core/CHANGELOG.md",
      ".changeset/tidy-lions-cheer.md",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "Cargo.lock",
      "go.sum",
    ]) {
      expect(isReleasePath(p)).toBe(true);
    }
    expect(isReleasePath("src/index.ts")).toBe(false);
    expect(isReleasePath("docs/changelog-notes.ts")).toBe(false);
  });

  it("isReleaseDiff: true only when EVERY path is release churn", () => {
    expect(isReleaseDiff(["CHANGELOG.md", ".changeset/x.md", "pnpm-lock.yaml"])).toBe(true);
    expect(isReleaseDiff(["CHANGELOG.md", "src/index.ts"])).toBe(false);
    expect(isReleaseDiff([])).toBe(false); // empty is never a release diff
  });
});

describe("review/policy — budget ceilings", () => {
  it("estimateTokens ~ chars/4", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
  });

  it("budgetSkipReason: 0 caps never skip", () => {
    expect(budgetSkipReason({ fileCount: 999, diffChars: 9_999_999 }, { effort: "normal", maxFiles: 0, maxTokens: 0 })).toBeNull();
  });

  it("budgetSkipReason: max_files ceiling", () => {
    expect(budgetSkipReason({ fileCount: 41, diffChars: 10 }, { effort: "normal", maxFiles: 40, maxTokens: 0 })).toMatch(/max_files/);
    expect(budgetSkipReason({ fileCount: 40, diffChars: 10 }, { effort: "normal", maxFiles: 40, maxTokens: 0 })).toBeNull();
  });

  it("budgetSkipReason: max_tokens ceiling (diff-size estimate)", () => {
    // 4001 chars -> ~1001 tokens > 1000
    expect(budgetSkipReason({ fileCount: 1, diffChars: 4001 }, { effort: "normal", maxFiles: 0, maxTokens: 1000 })).toMatch(/max_tokens/);
    expect(budgetSkipReason({ fileCount: 1, diffChars: 4000 }, { effort: "normal", maxFiles: 0, maxTokens: 1000 })).toBeNull();
  });
});

describe("review/policy — effort settings", () => {
  it("low: no triage, no verify, tight budget", () => {
    expect(effortSettings("low")).toEqual({ triage: false, verify: false, reviewerMaxTurns: 15 });
  });
  it("normal: verify on, no triage", () => {
    expect(effortSettings("normal")).toEqual({ triage: false, verify: true, reviewerMaxTurns: 30 });
  });
  it("high: triage + verify on, generous budget", () => {
    expect(effortSettings("high")).toEqual({ triage: true, verify: true, reviewerMaxTurns: 45 });
  });
});
