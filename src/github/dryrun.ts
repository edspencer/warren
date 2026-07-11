/**
 * DryRunSink — captures GitHub WRITE payloads instead of sending them.
 *
 * LOCAL-FIRST default: when `WARREN_LIVE` is false, every write method records the
 * exact request (method, url, body) here — kept in memory AND appended to a JSONL
 * file under the data dir — and returns a realistic synthetic response (fake ids).
 * Flipping live=true routes the identical requests to the network with no other
 * code change (see `createGitHubClient` in ./client.ts).
 *
 * The GitHub token is never part of a captured payload (auth headers are omitted).
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../types.js";
import type { WriteOutcome } from "./client.js";

export interface DryRunRequest {
  /** Logical write kind, e.g. "createReview", "upsertStickyComment". */
  kind: string;
  method: string;
  /** Full request URL (auth header intentionally excluded). */
  url: string;
  body?: unknown;
  /** Optional state key (targetKey) for grouping/introspection. */
  key?: string;
  /** Synthetic id/url the caller should receive as if the write had happened. */
  syntheticRef: string | number;
}

export interface DryRunEntry extends DryRunRequest {
  ts: string;
  ref: string | number;
}

let seq = 0;
/** Deterministic-ish synthetic numeric id (comment/review/reaction id). */
export function syntheticId(): number {
  seq += 1;
  return 900000000 + seq;
}
/** Synthetic GraphQL node id (thread ids etc.). */
export function syntheticNodeId(prefix = "DRYRUN"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export class DryRunSink {
  private readonly entries: DryRunEntry[] = [];
  private readonly filePath: string;

  constructor(
    private readonly dataDir: string,
    private readonly logger?: Logger,
  ) {
    this.filePath = path.join(dataDir, "writes.jsonl");
  }

  /** All captured writes so far (test/introspection). */
  get captured(): readonly DryRunEntry[] {
    return this.entries;
  }

  /** The JSONL file writes are appended to. */
  get capturePath(): string {
    return this.filePath;
  }

  /**
   * Record a captured write. Pushes to the in-memory log, appends one JSON line
   * to the JSONL file, and returns the synthetic WriteOutcome. File I/O failures
   * are logged, not thrown — a dry run must never break the pipeline.
   */
  async record(req: DryRunRequest): Promise<WriteOutcome> {
    const entry: DryRunEntry = {
      ...req,
      ts: new Date().toISOString(),
      ref: req.syntheticRef,
    };
    this.entries.push(entry);

    try {
      await mkdir(this.dataDir, { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      this.logger?.warn(
        `DryRunSink: failed to persist capture: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { dryRun: true, ref: req.syntheticRef, capturePath: this.filePath };
  }
}
