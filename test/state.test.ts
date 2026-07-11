import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createReviewStateStore,
  sanitizeKey,
  zeroPrState,
  type PrState,
} from "../src/state/store.js";
import { fingerprint } from "../src/review/fingerprint.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "warren-state-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("ReviewStateStore", () => {
  const KEY = "github:acme/widgets#42";

  it("returns a zero-value state for an unknown key (never null)", async () => {
    const store = createReviewStateStore(dataDir);
    const st = await store.getPrState(KEY);
    expect(st).toEqual(zeroPrState(KEY));
    expect(st.lastReviewedSha).toBe("");
    expect(st.postedFingerprints).toEqual([]);
    expect(st.stickyCommentId).toBeNull();
    expect(st.paused).toBe(false);
    expect(st.lastSeenCommentId).toBe(0);
  });

  it("round-trips a mutated state to disk", async () => {
    const store = createReviewStateStore(dataDir);
    const written = await store.setPrState(KEY, (s) => ({
      ...s,
      lastReviewedSha: "abc123",
      stickyCommentId: 999,
      paused: true,
      postedFingerprints: ["ff00", "ff01"],
    }));
    expect(written.lastReviewedSha).toBe("abc123");
    expect(written.updatedAt).not.toBe("");

    // A fresh store instance reads the same persisted state.
    const store2 = createReviewStateStore(dataDir);
    const read = await store2.getPrState(KEY);
    expect(read.lastReviewedSha).toBe("abc123");
    expect(read.stickyCommentId).toBe(999);
    expect(read.paused).toBe(true);
    expect(read.postedFingerprints).toEqual(["ff00", "ff01"]);
    expect(read.key).toBe(KEY);
  });

  it("writes atomically and leaves no temp files behind on overwrite", async () => {
    const store = createReviewStateStore(dataDir);
    await store.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "one" }));
    await store.setPrState(KEY, (s) => ({ ...s, lastReviewedSha: "two" }));
    const st = await store.getPrState(KEY);
    expect(st.lastReviewedSha).toBe("two");

    const files = await fs.readdir(path.join(dataDir, "state"));
    expect(files).toEqual([`${sanitizeKey(KEY)}.json`]);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("serializes concurrent mutations to the same key (no lost updates)", async () => {
    const store = createReviewStateStore(dataDir);
    // 20 concurrent appends; each reads-modifies-writes under the per-key lock.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.setPrState(KEY, (s) => ({
          ...s,
          postedFingerprints: [...s.postedFingerprints, `fp${i}`],
        })),
      ),
    );
    const st = await store.getPrState(KEY);
    expect(st.postedFingerprints).toHaveLength(20);
    expect(new Set(st.postedFingerprints).size).toBe(20);
  });

  it("dedups fingerprints via a mutate that appends only new ones", async () => {
    const store = createReviewStateStore(dataDir);
    const fpA = fingerprint({ path: "src/a.ts", category: "bug", title: "Off-by-one" });
    const fpDup = fingerprint({ path: "src/a.ts", category: "bug", title: "Off-by-one" });
    expect(fpA).toBe(fpDup); // deterministic

    const append = (fp: string) => (s: PrState): PrState => ({
      ...s,
      postedFingerprints: s.postedFingerprints.includes(fp)
        ? s.postedFingerprints
        : [...s.postedFingerprints, fp],
    });
    await store.setPrState(KEY, append(fpA));
    await store.setPrState(KEY, append(fpDup)); // same fingerprint, should not duplicate
    const st = await store.getPrState(KEY);
    expect(st.postedFingerprints).toEqual([fpA]);
  });

  it("lists known keys from persisted files", async () => {
    const store = createReviewStateStore(dataDir);
    await store.setPrState("github:acme/widgets#1", (s) => ({ ...s, lastReviewedSha: "x" }));
    await store.setPrState("localgit:/repo@local:seeded", (s) => ({ ...s, lastReviewedSha: "y" }));
    const keys = await store.listKeys();
    expect(keys.sort()).toEqual(
      ["github:acme/widgets#1", "localgit:/repo@local:seeded"].sort(),
    );
  });
});
