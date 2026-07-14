// ReviewStateStore: JSON-file-backed per-(repo,pr) review state under the data dir.
// See SPEC §3.4. One file per key at ${dataDir}/state/<sanitized-key>.json.
// Reads/modify/writes are serialized per key with an in-process async mutex and
// persisted atomically (temp file + rename).

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

/** Persisted per-target review state. */
export interface PrState {
  key: string; // targetKey(target)
  lastReviewedSha: string; // "" if never reviewed
  stickyCommentId: number | null; // walkthrough sticky comment id (github-pr only)
  postedFingerprints: string[]; // findings already posted (dedup across re-reviews)
  paused: boolean; // @warren pause
  ignored: boolean; // never auto-review (config or command)
  lastSeenCommentId: number; // highest comment id processed for commands (0 = none)
  reviewerSessionId: string; // herdctl session id of the last review (for @warren ask resume); "" = none
  answeredCommentIds: number[]; // comment ids already answered by an ask reply (dedup)
  updatedAt: string; // ISO ("" when never persisted)
}

export interface ReviewStateStore {
  /** Returns the stored state or a zero-value PrState if absent (never null). */
  getPrState(key: string): Promise<PrState>;
  /**
   * Read-modify-write under a per-key lock. `mutate` receives the current state,
   * returns the next state; the store persists it atomically. Returns the new state.
   */
  setPrState(key: string, mutate: (s: PrState) => PrState): Promise<PrState>;
  /** All known keys (for introspection / poll bookkeeping). */
  listKeys(): Promise<string[]>;
}

/** Zero-value state for a key that has never been persisted. */
export function zeroPrState(key: string): PrState {
  return {
    key,
    lastReviewedSha: "",
    stickyCommentId: null,
    postedFingerprints: [],
    paused: false,
    ignored: false,
    lastSeenCommentId: 0,
    reviewerSessionId: "",
    answeredCommentIds: [],
    updatedAt: "",
  };
}

/** Sanitize a key into a filesystem-safe base name (non-alnum -> "_"). */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "_");
}

class JsonFileReviewStateStore implements ReviewStateStore {
  private readonly stateDir: string;
  /** Per-key mutex: each setPrState chains onto the prior op for the same key. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.stateDir = path.join(dataDir, "state");
  }

  private fileFor(key: string): string {
    return path.join(this.stateDir, `${sanitizeKey(key)}.json`);
  }

  private async readFile(key: string): Promise<PrState> {
    const file = this.fileFor(key);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return zeroPrState(key);
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<PrState>;
    // Merge over the zero value so older/partial files stay forward-compatible.
    // Preserve the caller's canonical key rather than the sanitized-file variant.
    return { ...zeroPrState(key), ...parsed, key };
  }

  private async writeAtomic(key: string, state: PrState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const file = this.fileFor(key);
    const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    const body = JSON.stringify(state, null, 2);
    await fs.writeFile(tmp, body, "utf8");
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async getPrState(key: string): Promise<PrState> {
    // Read outside the lock but chained after any pending write for a consistent view.
    const pending = this.locks.get(key);
    if (pending) await pending.catch(() => {});
    return this.readFile(key);
  }

  async setPrState(key: string, mutate: (s: PrState) => PrState): Promise<PrState> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.then(async () => {
      const current = await this.readFile(key);
      const mutated = mutate(current);
      const persisted: PrState = { ...mutated, key, updatedAt: new Date().toISOString() };
      await this.writeAtomic(key, persisted);
      return persisted;
    });
    // Keep the chain alive even if this op rejects, so later ops still serialize.
    const guarded = next.catch(() => {});
    this.locks.set(key, guarded);
    // Once this op is the tail of the chain, drop the entry to bound map growth.
    void guarded.then(() => {
      if (this.locks.get(key) === guarded) this.locks.delete(key);
    });
    return next;
  }

  async listKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.stateDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const keys: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.stateDir, name), "utf8");
        const parsed = JSON.parse(raw) as Partial<PrState>;
        if (typeof parsed.key === "string" && parsed.key.length > 0) keys.push(parsed.key);
      } catch {
        // skip unreadable/partial files
      }
    }
    return keys;
  }
}

/** Factory: build a JSON-file-backed ReviewStateStore rooted at `dataDir`. */
export function createReviewStateStore(dataDir: string): ReviewStateStore {
  return new JsonFileReviewStateStore(dataDir);
}
