// src/trigger/queue.ts — JobQueue (SPEC §3.3) with supersede-by-key semantics.
//
// The queue sits directly behind a TriggerSource: the container pipes the source's
// `emit` into `enqueue`. Work is keyed on `targetKey(event.target)` so at most one
// review per target is ever in flight, and a NEWER event for a key supersedes the
// stale one:
//   • queued-but-not-started  → the queued event is REPLACED in place (latest wins);
//   • already IN-FLIGHT        → the running herdctl job is cancelled via
//                                `cancelInFlight(key)` and the newer event re-queued.
// Concurrency is bounded (default 2). The processing loop calls the injected
// `handler(event)`; handler rejections are caught + logged, never crashing the queue.
// Pure/offline-testable: no timers other than a macrotask pump, no I/O of its own.

import type { Logger, ReviewEvent } from "../types.js";
import { targetHeadSha, targetKey } from "../types.js";

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "superseded";

export interface JobQueue {
  /**
   * Enqueue a review job for `e`, keyed on targetKey(e.target).
   * Replaces a queued job for the same key; supersedes (cancels) an in-flight one
   * when a newer head arrives.
   */
  enqueue(e: ReviewEvent): void;
  /** Cancel the queued and/or in-flight job for a key (wires herdctl cancelJob). */
  cancel(key: string): Promise<void>;
  /** Current status for a key, or undefined if never seen. */
  status(key: string): JobStatus | undefined;
  /** Number of jobs currently running. */
  activeCount(): number;
  /** Drain: stop accepting new work, wait for in-flight jobs to settle. */
  stop(): Promise<void>;
}

export interface JobQueueDeps {
  /** The unit of work — bound to ReviewPipeline.run by the container. */
  handler: (e: ReviewEvent) => Promise<unknown>;
  /** Max parallel jobs. Default 2. */
  concurrency?: number;
  /**
   * Cancel an in-flight herdctl job for a key (supersede/cancel). No-op if none.
   * Supplied by herd/run.ts (`herd.cancel`). Errors are swallowed + logged.
   */
  cancelInFlight?: (key: string) => void | Promise<void>;
  logger?: Logger;
}

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface QueuedJob {
  key: string;
  event: ReviewEvent;
}

interface RunningJob {
  key: string;
  head: string;
  /** Set when the run has been abandoned (superseded/canceled); suppresses status writes. */
  abandoned: boolean;
  /** Resolves when the handler settles (for stop()/drain). */
  done: Promise<void>;
}

class DefaultJobQueue implements JobQueue {
  private readonly handler: (e: ReviewEvent) => Promise<unknown>;
  private readonly concurrency: number;
  private readonly cancelInFlight?: (key: string) => void | Promise<void>;
  private readonly logger: Logger;

  private stopped = false;
  private pumpScheduled = false;

  /** key → queued (not yet started) job. */
  private readonly queued = new Map<string, QueuedJob>();
  /** FIFO order of queued keys (may contain stale entries; filtered on pop). */
  private order: string[] = [];
  /** key → in-flight job. */
  private readonly running = new Map<string, RunningJob>();
  /** key → last known status. */
  private readonly statuses = new Map<string, JobStatus>();

  constructor(deps: JobQueueDeps) {
    this.handler = deps.handler;
    this.concurrency = Math.max(1, deps.concurrency ?? 2);
    this.cancelInFlight = deps.cancelInFlight;
    this.logger = deps.logger ?? noopLogger;
  }

  enqueue(e: ReviewEvent): void {
    if (this.stopped) return;
    const key = targetKey(e.target);
    const head = targetHeadSha(e.target);

    const running = this.running.get(key);
    if (running) {
      const isNewer = head === "" || head !== running.head || e.reason === "command";
      if (!isNewer) {
        // Same head, not a command → a duplicate of the in-flight run; drop it.
        this.logger.debug(`queue: dropping duplicate for ${key} (head ${head})`);
        return;
      }
      // Supersede the in-flight run, then (re)queue the newer event below.
      running.abandoned = true;
      this.setStatus(key, "superseded");
      void this.doCancelInFlight(key);
    }

    const existing = this.queued.get(key);
    if (existing) {
      // Replace the stale queued event; keep its FIFO position (latest wins).
      existing.event = e;
    } else {
      this.queued.set(key, { key, event: e });
      this.order.push(key);
    }
    this.setStatus(key, "queued");
    this.schedulePump();
  }

  async cancel(key: string): Promise<void> {
    let touched = false;
    if (this.queued.delete(key)) {
      this.setStatus(key, "canceled");
      touched = true;
    }
    const running = this.running.get(key);
    if (running) {
      running.abandoned = true;
      this.setStatus(key, "canceled");
      await this.doCancelInFlight(key);
      touched = true;
    }
    if (touched) this.logger.info(`queue: canceled ${key}`);
  }

  status(key: string): JobStatus | undefined {
    return this.statuses.get(key);
  }

  activeCount(): number {
    return this.running.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queued.clear();
    this.order = [];
    const inflight = [...this.running.values()].map((r) => r.done);
    await Promise.allSettled(inflight);
  }

  // ── internals ──

  private setStatus(key: string, status: JobStatus): void {
    this.statuses.set(key, status);
  }

  private async doCancelInFlight(key: string): Promise<void> {
    if (!this.cancelInFlight) return;
    try {
      await this.cancelInFlight(key);
    } catch (err) {
      this.logger.warn(`queue: cancelInFlight(${key}) failed`, err);
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.stopped) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.pump();
    }, 0);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running.size < this.concurrency) {
      const key = this.nextQueuedKey();
      if (key === null) break;
      const job = this.queued.get(key)!;
      this.queued.delete(key);
      this.startJob(job);
    }
  }

  /** Next queued key not already running; drops stale/removed entries. */
  private nextQueuedKey(): string | null {
    while (this.order.length > 0) {
      const key = this.order.shift()!;
      if (this.queued.has(key) && !this.running.has(key)) return key;
    }
    return null;
  }

  private startJob(job: QueuedJob): void {
    const running: RunningJob = {
      key: job.key,
      head: targetHeadSha(job.event.target),
      abandoned: false,
      done: Promise.resolve(),
    };
    this.running.set(job.key, running);
    this.setStatus(job.key, "running");

    running.done = Promise.resolve()
      .then(() => this.handler(job.event))
      .then(
        () => {
          if (!running.abandoned) this.setStatus(job.key, "done");
        },
        (err: unknown) => {
          if (running.abandoned) return;
          this.setStatus(job.key, "failed");
          this.logger.error(`queue: job ${job.key} failed`, err);
        },
      )
      .finally(() => {
        // Only clear if this exact run is still the tracked one.
        if (this.running.get(job.key) === running) this.running.delete(job.key);
        this.schedulePump();
      });
  }
}

/** Build a JobQueue with supersede-by-key + bounded concurrency (default 2). */
export function createJobQueue(deps: JobQueueDeps): JobQueue {
  return new DefaultJobQueue(deps);
}
