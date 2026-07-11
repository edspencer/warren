import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubClient } from "../src/github/client.js";
import type { RepoRef } from "../src/types.js";

const repo: RepoRef = { owner: "acme", name: "widget" };

describe("dry-run GitHub client", () => {
  let calls = 0;
  // A fetch that fails the test if any WRITE touches the network.
  const throwingFetch = (async () => {
    calls += 1;
    throw new Error("fetch must not be called for dry-run writes");
  }) as unknown as typeof fetch;

  afterEach(() => {
    calls = 0;
  });

  function client(dataDir: string) {
    return createGitHubClient({ token: "SECRET", live: false, dataDir, fetchImpl: throwingFetch });
  }

  it("captures writes to the sink without hitting the network", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "warren-dryrun-"));
    const gh = client(dataDir);

    const review = await gh.createReview(repo, 7, {
      commitId: "deadbeef",
      body: "Summary",
      event: "COMMENT",
      comments: [{ path: "src/a.ts", body: "issue <!-- finding:abc -->", line: 3, side: "RIGHT" }],
    });
    const reply = await gh.replyToThread(repo, 7, 42, "thanks");
    const reaction = await gh.addReaction(repo, 99, "eyes");
    const resolved = await gh.resolveThread(repo, "PRRT_thread1");

    expect(calls).toBe(0); // no network for any write

    for (const outcome of [review, reply, reaction, resolved]) {
      expect(outcome.dryRun).toBe(true);
      expect(outcome.ref).toBeTruthy();
      expect(outcome.capturePath).toBeTruthy();
    }

    // JSONL persisted: one line per captured write.
    const lines = readFileSync(path.join(dataDir, "writes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);

    const byKind = new Map(lines.map((e) => [e.kind, e]));
    expect(byKind.get("createReview")).toMatchObject({ method: "POST" });
    expect(byKind.get("createReview").url).toContain("/pulls/7/reviews");
    expect((byKind.get("createReview").body as { commit_id: string }).commit_id).toBe("deadbeef");
    expect(byKind.get("replyToThread").url).toContain("/comments/42/replies");
    expect(byKind.get("addReaction").url).toContain("/comments/99/reactions");
    expect(byKind.get("resolveThread").url).toContain("/graphql");

    // The token must never leak into a captured payload.
    for (const e of lines) expect(JSON.stringify(e)).not.toContain("SECRET");
  });

  it("returns synthetic ids that differ per write", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "warren-dryrun-"));
    const gh = client(dataDir);
    const a = await gh.replyToThread(repo, 1, 10, "a");
    const b = await gh.replyToThread(repo, 1, 11, "b");
    expect(a.ref).not.toBe(b.ref);
    expect(calls).toBe(0);
  });
});
