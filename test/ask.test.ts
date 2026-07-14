import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TriggerResult } from "@herdctl/core";
import { handleAsk, type AskHandlerDeps } from "../src/herd/ask.js";
import { createReviewStateStore, type ReviewStateStore } from "../src/state/store.js";
import type { FleetWrapper, FleetTriggerOptions } from "../src/herd/fleet.js";
import type { GitHubClient, WriteOutcome } from "../src/github/client.js";
import type { MaterializedTarget, ReviewTargetProvider } from "../src/review/target.js";
import type { GithubPrTarget, Logger, WarrenCommand, WarrenConfig } from "../src/types.js";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeConfig(): WarrenConfig {
  return {
    profile: "chill",
    minSeverity: "low",
    trigger: { mode: "poll", pollIntervalMs: 60000 },
    autoReview: { enabled: true, drafts: false, baseBranches: ["main"] },
    pathFilters: [],
    pathInstructions: [],
    walkthrough: { sequenceDiagrams: false, poem: false },
    commandsAllowed: ["review", "ask"],
    models: { triage: "haiku", review: "opus", verify: "haiku" },
    resolveOnFix: true,
    live: false,
    repos: [],
    concurrency: 1,
  };
}

function ghTarget(over: Partial<GithubPrTarget> = {}): GithubPrTarget {
  return {
    kind: "github-pr",
    repo: { owner: "acme", name: "widgets" },
    prNumber: 42,
    headSha: "headsha",
    baseSha: "basesha",
    baseRef: "main",
    ...over,
  };
}

/** A fake provider: materialize returns a stub checkout; records dispose calls. */
function fakeProvider(disposed: { n: number }): ReviewTargetProvider {
  return {
    async materialize(): Promise<MaterializedTarget> {
      return {
        kind: "github-pr",
        headSha: "headsha",
        baseSha: "basesha",
        diff: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
        files: [{ path: "x.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@" }],
        checkoutDir: "/tmp/fake-checkout",
        context: { title: "Add widget", body: "Adds a widget.", author: "alice" },
        async readFile() {
          return "";
        },
        async dispose() {
          disposed.n += 1;
        },
      };
    },
  };
}

interface TriggerCall {
  agentName: string;
  opts: FleetTriggerOptions;
}

/** A fake fleet whose reviewer/ask turn emits `answer` as assistant text and echoes
 *  the resume value it was given. Records every trigger call for assertions. */
function fakeFleet(answer: string, calls: TriggerCall[]): FleetWrapper {
  return {
    fleet: {} as never,
    async addReviewAgent() {
      return { name: "fake" } as never;
    },
    async trigger(agentName, opts): Promise<TriggerResult> {
      calls.push({ agentName, opts });
      opts.onMessage?.({
        type: "assistant",
        message: { content: [{ type: "text", text: answer }] },
      } as never);
      return {
        jobId: "job-1",
        agentName,
        scheduleName: null,
        startedAt: new Date().toISOString(),
        success: true,
        sessionId: "new-session",
      };
    },
    async cancel() {},
    async stop() {},
  };
}

interface CapturedPost {
  method: "issue" | "reply";
  prNumber: number;
  commentId?: number;
  body: string;
}

/** A fake GitHub client capturing the ONE write path the ask handler uses. */
function fakeClient(captured: CapturedPost[]): GitHubClient {
  const ok = (): WriteOutcome => ({ dryRun: true, ref: 123 });
  return {
    async postIssueComment(_repo, prNumber, body) {
      captured.push({ method: "issue", prNumber, body });
      return ok();
    },
    async replyToThread(_repo, prNumber, commentId, body) {
      captured.push({ method: "reply", prNumber, commentId, body });
      return ok();
    },
  } as unknown as GitHubClient;
}

function askCommand(over: Partial<WarrenCommand> = {}): WarrenCommand {
  return {
    kind: "ask",
    raw: "@warren why is this safe?",
    question: "why is this safe?",
    commentId: 555,
    author: "bob",
    commentKind: "issue",
    ...over,
  };
}

describe("handleAsk — conversational @warren replies", () => {
  let dataDir: string;
  let state: ReviewStateStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "warren-ask-"));
    state = createReviewStateStore(dataDir);
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function deps(
    fleet: FleetWrapper,
    client: GitHubClient | null,
    disposed = { n: 0 },
  ): AskHandlerDeps {
    return {
      fleet,
      provider: fakeProvider(disposed),
      state,
      clientFor: () => client,
      config: () => makeConfig(),
      logger: silentLogger,
    };
  }

  it("resumes the stored reviewer session and posts the answer", async () => {
    const key = "github:acme/widgets#42";
    await state.setPrState(key, (s) => ({ ...s, reviewerSessionId: "review-session-1" }));

    const calls: TriggerCall[] = [];
    const captured: CapturedPost[] = [];
    const disposed = { n: 0 };
    const res = await handleAsk(deps(fakeFleet("It is safe because the input is validated.", calls), fakeClient(captured), disposed), {
      target: ghTarget(),
      command: askCommand(),
    });

    expect(res.answered).toBe(true);
    expect(res.resumedSession).toBe("review-session-1");
    // The turn was RESUMED with the stored reviewer session id.
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.resume).toBe("review-session-1");
    // The security hardening was applied (survives resume via systemPromptAppend).
    expect(calls[0].opts.systemPromptAppend).toMatch(/UNTRUSTED/i);
    // The answer was posted as a new PR conversation comment addressed to the asker.
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("issue");
    expect(captured[0].body).toContain("It is safe because the input is validated.");
    expect(captured[0].body).toContain("@bob");
    // The checkout was disposed.
    expect(disposed.n).toBe(1);
    // The comment id was recorded as answered.
    const st = await state.getPrState(key);
    expect(st.answeredCommentIds).toContain(555);
  });

  it("replies in-thread for a review (diff) comment", async () => {
    const calls: TriggerCall[] = [];
    const captured: CapturedPost[] = [];
    const res = await handleAsk(deps(fakeFleet("Because the loop terminates.", calls), fakeClient(captured)), {
      target: ghTarget(),
      command: askCommand({ commentKind: "review", commentId: 999 }),
    });

    expect(res.answered).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("reply");
    expect(captured[0].commentId).toBe(999);
    // In-thread replies are not @-prefixed (they are already threaded).
    expect(captured[0].body).toBe("Because the loop terminates.");
  });

  it("falls back to a fresh session (resume=null) when there is no reviewer session", async () => {
    const calls: TriggerCall[] = [];
    const captured: CapturedPost[] = [];
    const res = await handleAsk(deps(fakeFleet("Answer from reconstructed context.", calls), fakeClient(captured)), {
      target: ghTarget(),
      command: askCommand(),
    });

    expect(res.answered).toBe(true);
    expect(res.resumedSession).toBeUndefined();
    expect(calls[0].opts.resume).toBeNull();
    // The fallback reconstructs PR context into the prompt (UNTRUSTED-fenced diff/title).
    expect(calls[0].opts.prompt).toContain("no prior review session");
    expect(calls[0].opts.prompt).toContain("Add widget");
  });

  it("does NOT answer a comment id already in answeredCommentIds", async () => {
    const key = "github:acme/widgets#42";
    await state.setPrState(key, (s) => ({ ...s, answeredCommentIds: [555] }));

    const calls: TriggerCall[] = [];
    const captured: CapturedPost[] = [];
    const res = await handleAsk(deps(fakeFleet("should not run", calls), fakeClient(captured)), {
      target: ghTarget(),
      command: askCommand({ commentId: 555 }),
    });

    expect(res.answered).toBe(false);
    expect(res.reason).toBe("already-answered");
    // No turn was run and nothing was posted.
    expect(calls).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it("skips a non-github target and an empty question", async () => {
    const calls: TriggerCall[] = [];
    const captured: CapturedPost[] = [];
    const d = deps(fakeFleet("x", calls), fakeClient(captured));

    const localRes = await handleAsk(d, {
      target: { kind: "local-git", repoDir: "/tmp/x", baseRef: "main", headRef: "head", label: "l" },
      command: askCommand(),
    });
    expect(localRes).toEqual({ answered: false, reason: "not-github-pr" });

    const emptyRes = await handleAsk(d, { target: ghTarget(), command: askCommand({ question: "   " }) });
    expect(emptyRes.reason).toBe("empty-question");
    expect(calls).toHaveLength(0);
  });

  it("returns no-client (does not throw) when no GitHub client is available", async () => {
    const calls: TriggerCall[] = [];
    const res = await handleAsk(deps(fakeFleet("x", calls), null), {
      target: ghTarget(),
      command: askCommand(),
    });
    expect(res.reason).toBe("no-client");
    expect(calls).toHaveLength(0);
  });
});
