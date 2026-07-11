// src/container.ts — Warren composition root (poor-man's DI).
//
// Constructs every concrete impl and wires the deps described in the SPEC
// (§ container). Returns a WarrenApp: the pipeline, queue, trigger source, fleet,
// resolved config + logger, a one-shot local-review helper, and start()/stop().

import path from "node:path";

import { readEnv, type WarrenEnv } from "./config/env.js";
import { loadWarrenConfig, resolveRepoConfig } from "./config/load.js";
import { createReviewStateStore, type ReviewStateStore } from "./state/store.js";
import { createGitHubClient, type GitHubClient } from "./github/client.js";
import {
  createReviewTargetProvider,
  runGit,
  sanitizeKey,
  type ReviewTargetProvider,
} from "./review/target.js";
import { createFleet, type FleetWrapper } from "./herd/fleet.js";
import { createReviewPipeline, type ReviewPipeline } from "./review/pipeline.js";
import { createJobQueue, type JobQueue } from "./trigger/queue.js";
import { createTriggerSource, type TriggerSource } from "./trigger/source.js";
import {
  targetKey,
  type LocalGitTarget,
  type Logger,
  type RepoConfig,
  type ReviewEvent,
  type ReviewResult,
  type ReviewTarget,
  type WarrenConfig,
} from "./types.js";

// ─────────────────────────── Public shape ───────────────────────────

export interface WarrenApp {
  pipeline: ReviewPipeline;
  queue: JobQueue;
  trigger: TriggerSource;
  fleet: FleetWrapper;
  state: ReviewStateStore;
  provider: ReviewTargetProvider;
  config: WarrenConfig;
  env: WarrenEnv;
  logger: Logger;
  dataDir: string;
  /** Watched repos (server config + WARREN_REPOS), for introspection. */
  repos: RepoConfig[];
  /** Boot the trigger source; events flow into the job queue. Idempotent-ish. */
  start(): Promise<void>;
  /** Tear everything down: trigger → queue drain → fleet. Idempotent. */
  stop(): Promise<void>;
  /** One-shot: review a local-git diff (base..head) once and return the result. */
  reviewLocal(repoDir: string, baseRef: string, headRef: string): Promise<LocalReviewOutcome>;
  /** Resolve the effective config for a target (per-repo overrides applied). */
  configFor(target: ReviewTarget): WarrenConfig;
  /** GitHub client for a target (null for local-git or when no token is set). */
  clientFor(target: ReviewTarget): GitHubClient | null;
}

export interface LocalReviewOutcome {
  result: ReviewResult;
  /** Absolute path to the markdown report the pipeline wrote for this review. */
  reportPath: string;
}

export interface CreateContainerOptions {
  /** Path to a server-level .warren.yaml. Missing file → all-defaults config. */
  configPath?: string;
  /** Process env (defaults to process.env, read via config/env.ts). */
  env?: NodeJS.ProcessEnv;
}

// ─────────────────────────── Logger ───────────────────────────

function createConsoleLogger(): Logger {
  return {
    info: (...a: unknown[]) => console.log("[warren]", ...a),
    warn: (...a: unknown[]) => console.warn("[warren]", ...a),
    error: (...a: unknown[]) => console.error("[warren]", ...a),
    debug: (...a: unknown[]) => {
      if (process.env.WARREN_DEBUG) console.debug("[warren]", ...a);
    },
  };
}

// ─────────────────────────── Factory ───────────────────────────

/** Build a fully-wired Warren application. Boots the herdctl fleet eagerly. */
export async function createContainer(opts: CreateContainerOptions = {}): Promise<WarrenApp> {
  const logger = createConsoleLogger();
  const env = readEnv(opts.env ?? process.env);
  const dataDir = path.resolve(env.dataDir);

  // Server config (missing file → defaults); WARREN_LIVE overrides `live`.
  const configPath = opts.configPath ?? path.join(process.cwd(), ".warren.yaml");
  const loaded = await loadWarrenConfig(configPath, env);

  // Merge WARREN_REPOS (csv owner/name) into the watched-repo list.
  const envRepos: RepoConfig[] = env.repos.map((slug) => {
    const [owner, name] = slug.split("/");
    return { github: { owner: owner ?? slug, name: name ?? "" } };
  });
  const config: WarrenConfig = { ...loaded, repos: [...loaded.repos, ...envRepos] };

  // Per-target effective config (per-repo overrides applied).
  const configFor = (target: ReviewTarget): WarrenConfig => {
    const match = config.repos.find((r) => {
      if (target.kind === "github-pr") {
        return (
          r.github?.owner === target.repo.owner && r.github?.name === target.repo.name
        );
      }
      return r.localGit?.repoDir === target.repoDir && r.localGit?.label === target.label;
    });
    return match ? resolveRepoConfig(config, match) : config;
  };

  // State store.
  const state = createReviewStateStore(dataDir);

  // GitHub client factory: one shared client per token (reads identical regardless of
  // key); WARREN_LIVE selects live vs dry-run. null for local-git targets.
  const sharedClient: GitHubClient | null = env.githubToken
    ? createGitHubClient({
        token: env.githubToken,
        live: env.live,
        dataDir,
        logger,
      })
    : null;
  const clientFor = (target: ReviewTarget): GitHubClient | null =>
    target.kind === "github-pr" ? sharedClient : null;

  // Target provider (github clone / local-git worktree + path filtering).
  const provider = createReviewTargetProvider({
    dataDir,
    logger,
    clientFor,
    githubToken: env.githubToken,
    pathFiltersFor: (t) => configFor(t).pathFilters,
  });

  // Fleet (boots the FleetManager). runtime forced to cli by fleet defaults.
  const fleet = await createFleet({
    dataDir,
    defaults: { runtime: env.runtime, model: config.models.review },
  });

  // Review pipeline: the unit of work behind the queue.
  const pipeline = createReviewPipeline({
    provider,
    fleet,
    state,
    config: configFor,
    clientFor,
    dataDir,
    logger,
  });

  // Job queue: keyed on targetKey, superseding on new heads.
  const queue = createJobQueue({
    handler: (e: ReviewEvent) => pipeline.run(e),
    concurrency: config.concurrency,
    cancelInFlight: (key: string) => {
      // The pipeline owns herd job ids internally; container-level supersede is
      // best-effort (queued replacement still applies). Logged for observability.
      logger.debug(`queue: supersede requested for ${key}`);
    },
    logger,
  });

  // Trigger source (poll by default). A client is required by the seam even when
  // only local-git repos are watched; reads are never issued for local-git.
  const triggerClient: GitHubClient =
    sharedClient ??
    createGitHubClient({ token: env.githubToken ?? "", live: env.live, dataDir, logger });
  const trigger = createTriggerSource(config.trigger.mode, {
    client: triggerClient,
    state,
    config,
    configFor: (repo) => resolveRepoConfig(config, repo),
    resolveLocalGitHead: async (t: LocalGitTarget) =>
      (await runGit(["rev-parse", t.headRef], { cwd: t.repoDir })).trim(),
    logger,
  });

  let started = false;
  let stopped = false;

  return {
    pipeline,
    queue,
    trigger,
    fleet,
    state,
    provider,
    config,
    env,
    logger,
    dataDir,
    repos: config.repos,
    configFor,
    clientFor,

    async start(): Promise<void> {
      if (started) return;
      started = true;
      await trigger.start((e) => queue.enqueue(e));
      logger.info(
        `trigger started: mode=${config.trigger.mode} watching ${config.repos.length} repo(s), ` +
          `mode=${env.live ? "LIVE" : "dry-run"}`,
      );
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await trigger.stop().catch((e) => logger.warn("trigger.stop failed", e));
      await queue.stop().catch((e) => logger.warn("queue.stop failed", e));
      await fleet.stop().catch((e) => logger.warn("fleet.stop failed", e));
    },

    async reviewLocal(repoDir, baseRef, headRef): Promise<LocalReviewOutcome> {
      const abs = path.resolve(repoDir);
      const target: LocalGitTarget = {
        kind: "local-git",
        repoDir: abs,
        baseRef,
        headRef,
        label: `local:${headRef}`,
      };
      const event: ReviewEvent = {
        target,
        reason: "manual",
        full: true,
        receivedAt: new Date().toISOString(),
      };
      const result = await pipeline.run(event);
      // The pipeline writes ${dataDir}/reviews/<sanitized-key>-<head>.md; recompute it.
      const key = targetKey(target);
      const head = result.stats.filesReviewed > 0 ? await resolveHead(abs, headRef) : "head";
      const reportPath = path.join(
        dataDir,
        "reviews",
        `${sanitizeKey(key)}-${head || "head"}.md`,
      );
      return { result, reportPath };
    },
  };
}

async function resolveHead(repoDir: string, ref: string): Promise<string> {
  try {
    return (await runGit(["rev-parse", ref], { cwd: repoDir })).trim();
  } catch {
    return "head";
  }
}
