// src/trigger/source.ts — TriggerSource seam (SPEC §3.2) + factory.
//
// A TriggerSource normalizes any origin (poll loop now; webhook/tunnel later) into
// ReviewEvents and drops each onto `emit`. It owns NOTHING downstream: the container
// pipes `emit` straight into the JobQueue. `emit` must never throw — the queue owns
// its own errors — and a source that overruns should log and continue, never crash the
// host process. `stop()` releases timers/sockets and is idempotent.

import type {
  Logger,
  RepoConfig,
  ReviewEvent,
  WarrenConfig,
  LocalGitTarget,
} from "../types.js";
import type { GitHubClient } from "../github/client.js";
import type { ReviewStateStore } from "../state/store.js";
import { PollTriggerSource } from "./poll.js";
import { WebhookStubTriggerSource } from "./webhook-stub.js";

export interface TriggerSource {
  /** Begin producing ReviewEvents. `emit` is called once per event; it must not throw. */
  start(emit: (e: ReviewEvent) => void): Promise<void>;
  /** Stop producing events and release resources (timers, sockets). Idempotent. */
  stop(): Promise<void>;
}

/**
 * Dependencies shared by every TriggerSource impl. The container constructs one of
 * these and hands it to `createTriggerSource`. `config` is the server-level
 * WarrenConfig (its `.repos` drives what is watched); `configFor` resolves the
 * per-repo merged config when repo overrides matter (base branches / drafts /
 * allowed commands). `resolveLocalGitHead` is an optional hook so the poll source
 * can watch a local-git target without pulling git plumbing into the trigger layer.
 */
export interface TriggerSourceDeps {
  client: GitHubClient;
  state: ReviewStateStore;
  config: WarrenConfig;
  /** Resolve the merged per-repo config; defaults to the server `config`. */
  configFor?: (repo: RepoConfig) => WarrenConfig;
  /** Resolve the current head SHA for a local-git target (git rev-parse). Optional. */
  resolveLocalGitHead?: (t: LocalGitTarget) => Promise<string>;
  /** Bot login, so the command scanner ignores the bot's own comments. */
  botLogin?: string;
  logger: Logger;
}

export type TriggerMode = WarrenConfig["trigger"]["mode"];

/**
 * Select the TriggerSource for a mode. `poll` is the M1 default (outbound-only, works
 * with no public ingress); `webhook`/`tunnel` return the M4 stub which throws on start
 * until implemented. Poll and webhook are swappable because both satisfy TriggerSource.
 */
export function createTriggerSource(
  mode: TriggerMode,
  deps: TriggerSourceDeps,
): TriggerSource {
  // poll/webhook only import this module's *types*, so static imports create no cycle.
  if (mode === "webhook" || mode === "tunnel") {
    return new WebhookStubTriggerSource(deps, mode);
  }
  return new PollTriggerSource(deps);
}
