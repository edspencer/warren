// src/trigger/poll.ts — PollTriggerSource (SPEC §3.2). The M1 default trigger.
//
// Outbound-only: no inbound server. On an interval (`trigger.pollIntervalMs`) it
// sweeps every watched RepoConfig and normalizes changes into ReviewEvents:
//   • github repos: list open PRs (skip drafts unless configured; respect
//     `autoReview.baseBranches`; skip paused/ignored per the state store); emit
//     new_pr/new_head when a head SHA differs from `lastReviewedSha`. Also scan
//     recent PR comments for `@warren` commands (commands.ts) — emitting
//     reason:"command" events and applying pause/resume to the state store.
//   • local-git repos: resolve the head via `resolveLocalGitHead` and emit on change.
//     No comment scan (there is no PR conversation).
//
// Robust to API errors: a repo that throws is logged and skipped; the tick continues.
// Ticks never overlap (an in-flight guard). A per-key debounce prevents re-emitting
// the same head before the pipeline has advanced `lastReviewedSha`. `emit` must never
// throw (the queue owns downstream errors); this source never crashes the host.

import type {
  GithubPrTarget,
  LocalGitTarget,
  Logger,
  RepoConfig,
  RepoRef,
  ReviewEvent,
  ReviewReason,
  WarrenConfig,
} from "../types.js";
import { repoLabel, targetKey } from "../types.js";
import type { PrInfo } from "../github/client.js";
import { parseWarrenCommand } from "./commands.js";
import { autoReviewDecision, commandAllowed } from "./policy.js";
import type { TriggerSource, TriggerSourceDeps } from "./source.js";

type EmitFn = (e: ReviewEvent) => void;

// Re-exported for backward compatibility; the canonical home is trigger/policy.ts.
export { isAuthorAllowed } from "./policy.js";

export class PollTriggerSource implements TriggerSource {
  private readonly deps: TriggerSourceDeps;
  private readonly logger: Logger;
  private readonly intervalMs: number;

  private started = false;
  private ticking = false;
  private emitFn: EmitFn | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** key → last head SHA we emitted, to debounce re-emits within a poll window. */
  private readonly emittedHeads = new Map<string, string>();

  constructor(deps: TriggerSourceDeps) {
    this.deps = deps;
    this.logger = deps.logger;
    this.intervalMs = Math.max(1000, deps.config.trigger.pollIntervalMs);
  }

  async start(emit: EmitFn): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emitFn = emit;
    // Kick the first tick on the next macrotask so start() returns promptly, then
    // reschedule after each tick (self-scheduling avoids overlap under slow ticks).
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delay: number): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void this.runLoop();
    }, delay);
  }

  private async runLoop(): Promise<void> {
    await this.tick();
    if (this.started) this.scheduleNext(this.intervalMs);
  }

  /**
   * Run one poll pass over every watched repo. Public + accepts an optional `emit`
   * so it is directly unit-testable without starting the interval. Never overlaps.
   */
  async tick(emit?: EmitFn): Promise<void> {
    const fn = emit ?? this.emitFn;
    if (!fn) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const repo of this.deps.config.repos) {
        try {
          await this.pollRepo(repo, fn);
        } catch (err) {
          this.logger.warn(`poll: repo ${repoLabel(repo)} failed`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private configFor(repo: RepoConfig): WarrenConfig {
    return this.deps.configFor ? this.deps.configFor(repo) : this.deps.config;
  }

  private async pollRepo(repo: RepoConfig, emit: EmitFn): Promise<void> {
    if (repo.github) {
      await this.pollGithubRepo(repo, this.configFor(repo), emit);
    } else if (repo.localGit) {
      await this.pollLocalGitRepo(repo, this.configFor(repo), emit);
    }
    // Repos with neither selector are ignored (config schema forbids this anyway).
  }

  // ── github ──

  private async pollGithubRepo(
    repo: RepoConfig,
    cfg: WarrenConfig,
    emit: EmitFn,
  ): Promise<void> {
    const gh = repo.github!;
    const ref: RepoRef = { owner: gh.owner, name: gh.name };
    const prs = await this.deps.client.listOpenPrs(ref);

    for (const pr of prs) {
      const target: GithubPrTarget = {
        kind: "github-pr",
        repo: ref,
        prNumber: pr.number,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        baseRef: pr.baseRef,
      };
      const key = targetKey(target);
      try {
        await this.scanCommands(ref, pr, target, key, cfg, emit);
        await this.maybeEmitAutoReview(pr, target, key, cfg, emit);
      } catch (err) {
        this.logger.warn(`poll: PR ${repoLabel(repo)}#${pr.number} failed`, err);
      }
    }
  }

  /** Scan new PR comments for @warren commands; apply pause/resume; emit the rest. */
  private async scanCommands(
    ref: RepoRef,
    pr: PrInfo,
    target: GithubPrTarget,
    key: string,
    cfg: WarrenConfig,
    emit: EmitFn,
  ): Promise<void> {
    const st = await this.deps.state.getPrState(key);
    const comments = await this.deps.client.listComments(ref, pr.number, st.lastSeenCommentId);
    if (comments.length === 0) return;

    let maxId = st.lastSeenCommentId;
    for (const c of comments) {
      if (c.id > maxId) maxId = c.id;
      const cmd = parseWarrenCommand(c, this.deps.botLogin);
      if (!cmd) continue;
      if (!cfg.commandsAllowed.includes(cmd.kind)) {
        this.logger.debug(`poll: command '${cmd.kind}' not allowed on ${key}; skipping`);
        continue;
      }
      if (cmd.kind === "pause") {
        await this.deps.state.setPrState(key, (s) => ({ ...s, paused: true }));
        this.logger.info(`poll: paused ${key} via @warren pause`);
        continue;
      }
      if (cmd.kind === "resume") {
        await this.deps.state.setPrState(key, (s) => ({ ...s, paused: false }));
        this.logger.info(`poll: resumed ${key} via @warren resume`);
        continue;
      }
      // SAFETY (#21/#26): apply author allow/deny + label policy to @warren
      // command-triggered reviews/answers — gate on the PR AUTHOR (whose PR gets
      // reviewed/commented on), not the commenter. Pause/resume above are harmless
      // state ops and are left ungated. Release/ignore heuristics do NOT block an
      // explicit human command. Empty gates = allow everyone (legacy behavior).
      if (!commandAllowed(pr, cfg.autoReview)) {
        this.logger.debug(
          `poll: PR author '${pr.author}' blocked by author/label policy; ignoring @warren '${cmd.kind}' on ${key}`,
        );
        continue;
      }
      emit({
        target,
        reason: "command",
        full: cmd.kind === "full_review",
        command: cmd,
        requestedBy: cmd.author,
        receivedAt: new Date().toISOString(),
      });
    }

    if (maxId > st.lastSeenCommentId) {
      await this.deps.state.setPrState(key, (s) => ({
        ...s,
        lastSeenCommentId: Math.max(s.lastSeenCommentId, maxId),
      }));
    }
  }

  /** Emit a new_pr/new_head event when the head changed and auto-review is eligible. */
  private async maybeEmitAutoReview(
    pr: PrInfo,
    target: GithubPrTarget,
    key: string,
    cfg: WarrenConfig,
    emit: EmitFn,
  ): Promise<void> {
    if (!cfg.autoReview.enabled) return;
    if (pr.draft && !cfg.autoReview.drafts) return;
    if (!cfg.autoReview.baseBranches.includes(pr.baseRef)) return;
    // Trigger policy (#21/#26): author allow/deny, label gating, title/branch
    // ignore patterns, and the release-PR skip. Empty/default config allows every
    // non-release PR (legacy behavior save for the default release skip).
    const decision = autoReviewDecision(pr, cfg.autoReview);
    if (!decision.allow) {
      this.logger.debug(`poll: skipping ${key} — ${decision.reason}`);
      return;
    }

    // Re-read state: a pause/resume command in this same tick may have changed it.
    const st = await this.deps.state.getPrState(key);
    if (st.paused || st.ignored) return;

    if (pr.headSha === st.lastReviewedSha) return; // nothing new
    if (this.emittedHeads.get(key) === pr.headSha) return; // debounce

    this.emittedHeads.set(key, pr.headSha);
    const reason: ReviewReason = st.lastReviewedSha ? "new_head" : "new_pr";
    emit({ target, reason, full: false, receivedAt: new Date().toISOString() });
  }

  // ── local-git ──

  private async pollLocalGitRepo(
    repo: RepoConfig,
    cfg: WarrenConfig,
    emit: EmitFn,
  ): Promise<void> {
    if (!cfg.autoReview.enabled) return;
    const resolve = this.deps.resolveLocalGitHead;
    if (!resolve) {
      this.logger.debug(`poll: no resolveLocalGitHead; skipping ${repoLabel(repo)}`);
      return;
    }
    const lg = repo.localGit!;
    const target: LocalGitTarget = {
      kind: "local-git",
      repoDir: lg.repoDir,
      baseRef: lg.baseRef,
      headRef: lg.headRef,
      label: lg.label,
    };
    const key = targetKey(target);

    const head = await resolve(target);
    const st = await this.deps.state.getPrState(key);
    if (st.paused || st.ignored) return;
    if (head === st.lastReviewedSha) return;
    if (this.emittedHeads.get(key) === head) return; // debounce

    this.emittedHeads.set(key, head);
    const reason: ReviewReason = st.lastReviewedSha ? "new_head" : "new_pr";
    emit({ target, reason, full: false, receivedAt: new Date().toISOString() });
  }
}
