import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger, ReviewEvent, WarrenConfig } from "../src/types.js";
import { targetKey } from "../src/types.js";
import type { GitHubClient, IssueComment, PrInfo } from "../src/github/client.js";
import { createReviewStateStore } from "../src/state/store.js";
import { PollTriggerSource } from "../src/trigger/poll.js";
import type { TriggerSourceDeps } from "../src/trigger/source.js";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 1,
    title: "Add feature",
    body: "",
    headSha: "sha1",
    baseSha: "base0",
    baseRef: "main",
    headRef: "feature",
    draft: false,
    state: "open",
    author: "alice",
    htmlUrl: "https://github.com/acme/widgets/pull/1",
    labels: [],
    ...over,
  };
}

function comment(over: Partial<IssueComment> = {}): IssueComment {
  return {
    id: 1,
    body: "lgtm",
    author: "bob",
    createdAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

/** Minimal fake GitHubClient: only the read methods PollTriggerSource touches. */
function fakeClient(prs: PrInfo[], commentsByPr: Record<number, IssueComment[]> = {}): GitHubClient {
  return {
    listOpenPrs: async () => prs,
    listComments: async (_ref, prNumber: number, sinceId?: number) => {
      const all = commentsByPr[prNumber] ?? [];
      const filtered = sinceId != null ? all.filter((c) => c.id > sinceId) : all;
      return [...filtered].sort((a, b) => a.id - b.id);
    },
    getPr: async (_ref, prNumber: number) => prs.find((p) => p.number === prNumber)!,
  } as unknown as GitHubClient;
}

/** Build a full autoReview block from a partial (fills the #26 filter defaults). */
function ar(over: Partial<WarrenConfig["autoReview"]> = {}): WarrenConfig["autoReview"] {
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

function config(over: Partial<WarrenConfig> = {}): WarrenConfig {
  return {
    profile: "chill",
    minSeverity: "medium",
    trigger: { mode: "poll", pollIntervalMs: 60_000 },
    autoReview: ar(),
    review: { effort: "normal", maxFiles: 0, maxTokens: 0 },
    pathFilters: [],
    pathInstructions: [],
    walkthrough: { sequenceDiagrams: false, poem: false },
    commandsAllowed: ["review", "full_review", "pause", "resume", "resolve", "help"],
    models: { triage: "h", review: "o", verify: "h" },
    resolveOnFix: true,
    live: false,
    repos: [{ github: { owner: "acme", name: "widgets" } }],
    concurrency: 2,
    ...over,
  };
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-poll-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function deps(over: Partial<TriggerSourceDeps> & Pick<TriggerSourceDeps, "client" | "config">): TriggerSourceDeps {
  return {
    state: createReviewStateStore(dataDir),
    logger: noopLogger,
    botLogin: "warren-bot",
    ...over,
  };
}

const KEY = targetKey({
  kind: "github-pr",
  repo: { owner: "acme", name: "widgets" },
  prNumber: 1,
  headSha: "sha1",
  baseSha: "base0",
  baseRef: "main",
});

describe("PollTriggerSource (github)", () => {
  it("emits new_pr for a never-seen PR", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(deps({ client: fakeClient([pr()]), config: config() }));
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("new_pr");
    expect(events[0]!.full).toBe(false);
    expect(targetKey(events[0]!.target)).toBe(KEY);
  });

  it("does not re-emit when the head is unchanged", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(deps({ state, client: fakeClient([pr({ headSha: "sha1" })]), config: config() }));
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(0);
  });

  it("emits new_head when the head SHA changed since last review", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "old" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(deps({ state, client: fakeClient([pr({ headSha: "sha2" })]), config: config() }));
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("new_head");
  });

  it("@warren pause sets paused and suppresses the auto-review emit", async () => {
    const state = createReviewStateStore(dataDir);
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1" })], {
          1: [comment({ id: 5, author: "alice", body: "@warren pause" })],
        }),
        config: config(),
      }),
    );
    await src.tick((e) => events.push(e));

    // pause is applied to state, and no review event is emitted for this PR.
    expect((await state.getPrState(KEY)).paused).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("emits a reason:'command' event for a @warren command comment", async () => {
    const state = createReviewStateStore(dataDir);
    // Pre-seed lastReviewedSha === head so auto-review does not also fire.
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1" })], {
          1: [comment({ id: 9, author: "alice", body: "@warren review" })],
        }),
        config: config(),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("command");
    expect(events[0]!.command?.kind).toBe("review");
    expect(events[0]!.requestedBy).toBe("alice");
    // The processed comment id is recorded so it is not re-emitted next tick.
    expect((await state.getPrState(KEY)).lastSeenCommentId).toBe(9);
  });

  it("emits a reason:'command' ask event (with question + channel) for a free-form @warren comment", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1" })], {
          1: [comment({ id: 12, author: "alice", body: "@warren why is this safe?", kind: "review" })],
        }),
        config: config({
          commandsAllowed: ["review", "full_review", "pause", "resume", "resolve", "help", "ask"],
        }),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("command");
    expect(events[0]!.command?.kind).toBe("ask");
    expect(events[0]!.command?.question).toBe("why is this safe?");
    expect(events[0]!.command?.commentKind).toBe("review");
    expect(events[0]!.full).toBe(false);
  });

  it("skips an ask when 'ask' is not in commandsAllowed", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1" })], {
          1: [comment({ id: 13, author: "alice", body: "@warren what does this do?" })],
        }),
        // Default config() omits "ask".
        config: config(),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(0);
    // The comment id is still advanced so it is not re-scanned every tick.
    expect((await state.getPrState(KEY)).lastSeenCommentId).toBe(13);
  });

  it("ignores the bot's own comments (no command loop)", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1" })], {
          1: [comment({ id: 3, author: "warren-bot", body: "@warren review" })],
        }),
        config: config(),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(0);
  });

  it("author allowlist: reviews an allowlisted author (case-insensitive)", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([pr({ author: "Alice" })]),
        // Different casing than the PR author to prove the match is case-insensitive.
        config: config({
          autoReview: ar({ authors: ["alice"] }),
        }),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("new_pr");
  });

  it("author allowlist: skips a non-allowlisted author (never enqueued)", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([pr({ author: "mallory" })]),
        config: config({
          autoReview: ar({ authors: ["alice"] }),
        }),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(0);
  });

  it("author allowlist: empty list reviews everyone (unchanged behavior)", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([pr({ author: "anyone" })]),
        config: config({
          autoReview: ar({ authors: [] }),
        }),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("new_pr");
  });

  it("author allowlist: ignores @warren commands on a non-allowlisted author's PR", async () => {
    const state = createReviewStateStore(dataDir);
    // Pre-seed lastReviewedSha === head so only the command path can fire.
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        // PR by a non-allowlisted author; even a commenter's @warren review is ignored.
        client: fakeClient([pr({ headSha: "sha1", author: "mallory" })], {
          1: [comment({ id: 9, author: "mallory", body: "@warren review" })],
        }),
        config: config({
          autoReview: ar({ authors: ["alice"] }),
        }),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(0);
    // The comment id is still advanced so it is not re-scanned every tick.
    expect((await state.getPrState(KEY)).lastSeenCommentId).toBe(9);
  });

  it("author allowlist: still honors @warren commands on an allowlisted author's PR", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));

    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1", author: "alice" })], {
          1: [comment({ id: 9, author: "alice", body: "@warren review" })],
        }),
        config: config({
          autoReview: ar({ authors: ["alice"] }),
        }),
      }),
    );
    await src.tick((e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("command");
    expect(events[0]!.command?.kind).toBe("review");
  });

  it("skips drafts and non-target base branches", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([
          pr({ number: 1, headSha: "s1", draft: true }),
          pr({ number: 2, headSha: "s2", baseRef: "release" }),
        ]),
        config: config({
          repos: [{ github: { owner: "acme", name: "widgets" } }],
        }),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(0);
  });

  it("skip_release_prs: skips a release PR (by title) but honors an explicit @warren command", async () => {
    const state = createReviewStateStore(dataDir);
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1", title: "chore: version packages" })], {
          1: [comment({ id: 4, author: "alice", body: "@warren review" })],
        }),
        config: config(),
      }),
    );
    await src.tick((e) => events.push(e));
    // No auto-review (release PR), but the explicit command still fires.
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("command");
  });

  it("skip_release_prs=false: a release PR IS auto-reviewed", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([pr({ title: "chore: version packages" })]),
        config: config({ autoReview: ar({ skipReleasePrs: false }) }),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("new_pr");
  });

  it("deny_authors: skips a denied author's PR and ignores its @warren command", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1", author: "noisybot" })], {
          1: [comment({ id: 7, author: "noisybot", body: "@warren review" })],
        }),
        config: config({ autoReview: ar({ denyAuthors: ["noisybot"] }) }),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(0);
  });

  it("skip_labels: a warren:skip label suppresses auto review", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([pr({ labels: ["warren:skip"] })]),
        config: config(),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(0);
  });

  it("only_labels: auto-reviews only PRs carrying a required label", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([
          pr({ number: 1, headSha: "s1", labels: [] }),
          pr({ number: 2, headSha: "s2", labels: ["needs-review"] }),
        ]),
        config: config({ autoReview: ar({ onlyLabels: ["needs-review"] }) }),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(1);
    expect((events[0]!.target as { prNumber: number }).prNumber).toBe(2);
  });

  it("only_labels: an explicit @warren command STILL runs on an unlabeled PR (scope filter bypassed)", async () => {
    const state = createReviewStateStore(dataDir);
    // Pre-seed lastReviewedSha === head so ONLY the command path can fire.
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        // PR lacks the required `needs-review` label → no AUTO review, but the
        // maintainer's explicit @warren review must still be honored.
        client: fakeClient([pr({ headSha: "sha1", labels: [] })], {
          1: [comment({ id: 8, author: "alice", body: "@warren review" })],
        }),
        config: config({ autoReview: ar({ onlyLabels: ["needs-review"] }) }),
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("command");
    expect(events[0]!.command?.kind).toBe("review");
  });

  it("command_associations: honors a COLLABORATOR command but blocks a NONE commenter (#32)", async () => {
    const state = createReviewStateStore(dataDir);
    await state.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "sha1" }));
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        state,
        client: fakeClient([pr({ headSha: "sha1" })], {
          1: [
            comment({ id: 8, author: "drive-by", body: "@warren review", authorAssociation: "NONE" }),
            comment({ id: 9, author: "maint", body: "@warren review", authorAssociation: "COLLABORATOR" }),
          ],
        }),
        config: config({
          autoReview: ar({ commandAssociations: ["OWNER", "MEMBER", "COLLABORATOR"] }),
        }),
      }),
    );
    await src.tick((e) => events.push(e));
    // Only the COLLABORATOR's command is honored; the NONE commenter is ignored.
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("command");
    expect(events[0]!.requestedBy).toBe("maint");
  });
});

describe("PollTriggerSource (local-git)", () => {
  it("emits new_pr when a local head resolves and differs from state", async () => {
    const events: ReviewEvent[] = [];
    const src = new PollTriggerSource(
      deps({
        client: fakeClient([]),
        config: config({
          repos: [
            {
              localGit: {
                repoDir: "/repo",
                baseRef: "main",
                headRef: "pr/seeded",
                label: "local:seeded",
              },
            },
          ],
        }),
        resolveLocalGitHead: async () => "localhead1",
      }),
    );
    await src.tick((e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("new_pr");
    expect(events[0]!.target.kind).toBe("local-git");
  });
});
