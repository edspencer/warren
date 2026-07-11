import { describe, it, expect } from "vitest";
import type { GithubPrTarget, ReviewEvent } from "../src/types.js";
import { targetKey } from "../src/types.js";
import { createJobQueue } from "../src/trigger/queue.js";

function ghTarget(prNumber: number, headSha: string): GithubPrTarget {
  return {
    kind: "github-pr",
    repo: { owner: "acme", name: "widgets" },
    prNumber,
    headSha,
    baseSha: "base0",
    baseRef: "main",
  };
}

function event(prNumber: number, headSha: string): ReviewEvent {
  return {
    target: ghTarget(prNumber, headSha),
    reason: "new_head",
    full: false,
    receivedAt: new Date().toISOString(),
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("JobQueue", () => {
  it("supersedes a queued job for the same key (head1 then head2 → only head2)", async () => {
    const processed: string[] = [];
    const q = createJobQueue({
      handler: async (e) => {
        processed.push((e.target as GithubPrTarget).headSha);
      },
    });

    // Two events for the SAME key back-to-back, before the (macrotask) pump fires.
    q.enqueue(event(1, "head1"));
    q.enqueue(event(1, "head2"));

    await delay(20);
    expect(processed).toEqual(["head2"]);
    await q.stop();
  });

  it("bounds concurrency (default 2) and drains the backlog as jobs finish", async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const q = createJobQueue({
      handler: (e) => {
        started.push(targetKey(e.target));
        return new Promise<void>((res) => gates.push(res));
      },
    });

    q.enqueue(event(1, "a"));
    q.enqueue(event(2, "b"));
    q.enqueue(event(3, "c"));

    await delay(20);
    // Only 2 of 3 distinct keys may run at once.
    expect(q.activeCount()).toBe(2);
    expect(started).toHaveLength(2);

    gates[0]!(); // release the first; the third should start
    await delay(20);
    expect(started).toHaveLength(3);
    expect(q.activeCount()).toBe(2);

    gates[1]!();
    gates[2]!();
    await delay(20);
    expect(q.activeCount()).toBe(0);
  });

  it("supersedes an IN-FLIGHT job when a newer head arrives (cancelInFlight)", async () => {
    const canceled: string[] = [];
    const gate = deferred();
    let firstHead: string | null = null;
    const q = createJobQueue({
      concurrency: 1,
      handler: (e) => {
        firstHead ??= (e.target as GithubPrTarget).headSha;
        return gate.promise; // block the first run until cancelInFlight releases it
      },
      cancelInFlight: (key) => {
        canceled.push(key);
        gate.resolve(); // let the abandoned run settle
      },
    });

    const key = targetKey(ghTarget(1, "head1"));
    q.enqueue(event(1, "head1"));
    await delay(20);
    expect(q.activeCount()).toBe(1);
    expect(firstHead).toBe("head1");

    q.enqueue(event(1, "head2")); // newer head → supersede in-flight
    await delay(20);
    expect(canceled).toContain(key);
    // The superseded run resolved; the newer head then ran to completion.
    expect(q.status(key)).toBe("done");
    await q.stop();
  });

  it("cancel(key) drops the in-flight job and reports canceled status", async () => {
    const canceled: string[] = [];
    const gate = deferred();
    const q = createJobQueue({
      concurrency: 1,
      handler: () => gate.promise,
      cancelInFlight: (key) => {
        canceled.push(key);
        gate.resolve();
      },
    });

    const key = targetKey(ghTarget(7, "z"));
    q.enqueue(event(7, "z"));
    await delay(20);
    expect(q.activeCount()).toBe(1);

    await q.cancel(key);
    expect(canceled).toContain(key);
    await delay(20);
    expect(q.status(key)).toBe("canceled");
    expect(q.activeCount()).toBe(0);
    await q.stop();
  });

  it("drops a duplicate enqueue for an in-flight key with the same head", async () => {
    let calls = 0;
    const gate = deferred();
    const q = createJobQueue({
      concurrency: 1,
      handler: () => {
        calls += 1;
        return gate.promise;
      },
    });

    q.enqueue(event(1, "same"));
    await delay(20);
    q.enqueue(event(1, "same")); // same head, in-flight → dropped
    await delay(20);
    expect(calls).toBe(1);

    gate.resolve();
    await q.stop();
  });
});
