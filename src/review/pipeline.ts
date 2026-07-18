// src/review/pipeline.ts — the review ORCHESTRATOR (SPEC §3.8).
//
// `createReviewPipeline(deps).run(event)` ties every already-built slice into one
// review: materialize the target → (triage hook) → agentic review pass → batched
// verify pass → severity/dedup gate → sink (GitHub batched review, or a local
// markdown report) → persist state. The pipeline is target-agnostic: only the
// ReviewTargetProvider knows target-kind mechanics, and the review agent's ONLY
// write path is the injected `github_pr` MCP collector, read here after each turn.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { GitHubClient, PrFile, ReviewSubmission } from "../github/index.js";
import { buildSuggestionBlock, mapFindingToHunk, parseDiff } from "../github/index.js";
import { createGithubPrMcp } from "../mcp/github-pr.js";
import type { ReviewStateStore } from "../state/store.js";
import type { ReviewHistoryStore } from "../state/history.js";
import type {
  Finding,
  Logger,
  RawFinding,
  ReviewEvent,
  ReviewResult,
  ReviewStats,
  ReviewTarget,
  Severity,
  WarrenConfig,
} from "../types.js";
import { targetKey } from "../types.js";
import type { FleetWrapper } from "../herd/fleet.js";
import { runAgentTurn } from "../herd/run.js";
import { reviewerAgentConfig, triageAgentConfig, verifyAgentConfig } from "../herd/reviewer.js";
import { fingerprint, encodeFindingMarker, decodeFindingMarker } from "./fingerprint.js";
import { effectiveMinSeverity, gateFindings, meetsSeverity } from "./gate.js";
import { budgetSkipReason, effortSettings, isReleaseDiff, resolveExecution } from "./policy.js";
import { buildBatchVerifyPrompt, buildReviewPrompt, buildReviewSystemAppend, buildTriagePrompt, toPromptContext } from "./prompts.js";
import { createReviewTargetProvider, type MaterializedTarget, type ReviewTargetProvider } from "./target.js";

/** The sticky walkthrough marker (SPEC §3.8 step 7). */
export const WALKTHROUGH_MARKER = "<!-- warren:walkthrough -->";

export interface ReviewPipelineDeps {
  /** Materializes targets into diff + checkout + file reads. */
  provider: ReviewTargetProvider;
  /** Live fleet wrapper used to register + trigger the per-pass agents. */
  fleet: FleetWrapper;
  /** Per-(repo,pr) review state (lastReviewedSha, dedup fingerprints, sticky id). */
  state: ReviewStateStore;
  /** Append-only review history (dashboard). Optional; skipped when absent. */
  history?: ReviewHistoryStore;
  /** Resolve the effective WarrenConfig for a target (per-repo overrides applied). */
  config: (target: ReviewTarget) => WarrenConfig;
  /** GitHub client for a github-pr target; null/absent for local-git. */
  clientFor?: (target: ReviewTarget) => GitHubClient | null;
  /** Root data dir; local-git reviews are written under `${dataDir}/reviews`. */
  dataDir: string;
  logger: Logger;
  /** Run the adversarial verify pass (noise killer). Default true. cfg-gate hook. */
  verify?: boolean;
  /** Run the triage pre-pass. Default false for M1 (hook left in place). */
  triage?: boolean;
  /**
   * On re-review, auto-resolve the GitHub thread of a previously-posted finding the
   * author has since fixed (no longer detected). Overrides `config.resolveOnFix` when set.
   */
  resolveOnFix?: boolean;
}

export interface ReviewPipeline {
  run(event: ReviewEvent): Promise<ReviewResult>;
}

/** Build a pipeline. `deps.provider` may be omitted to build the default provider. */
export function createReviewPipeline(deps: ReviewPipelineDeps): ReviewPipeline {
  const provider =
    deps.provider ??
    createReviewTargetProvider({
      dataDir: deps.dataDir,
      logger: deps.logger,
      clientFor: deps.clientFor,
      pathFiltersFor: (t) => deps.config(t).pathFilters,
    });
  return { run: (event) => runReview({ ...deps, provider }, event) };
}

// ─────────────────────────── Orchestration ───────────────────────────

async function runReview(deps: ReviewPipelineDeps, event: ReviewEvent): Promise<ReviewResult> {
  const start = Date.now();
  const target = event.target;
  const cfg = deps.config(target);
  const key = targetKey(target);
  // Effort knob (#26): drives whether triage/verify run + the reviewer turn budget.
  // Explicit deps.triage/deps.verify (tests, CLI) still override the effort default.
  const effort = effortSettings(cfg.review.effort);
  const verifyEnabled = deps.verify ?? effort.verify;
  const triageEnabled = deps.triage ?? effort.triage;
  const st = await deps.state.getPrState(key);

  // 1. Paused/ignored guard (explicit commands override).
  if ((st.paused || st.ignored) && event.reason !== "command") {
    deps.logger.info(`pipeline: ${key} is ${st.paused ? "paused" : "ignored"}; skipping.`);
    return noopResult(target, cfg, start, "");
  }

  // 2. Materialize (incremental unless full / brand-new).
  const mt = await deps.provider.materialize(target, {
    full: event.full,
    sinceSha: event.full ? "" : st.lastReviewedSha,
  });

  try {
    if (mt.files.length === 0) {
      deps.logger.info(`pipeline: ${key} has no changed files; advancing lastReviewedSha.`);
      await deps.state.setPrState(key, (s) => ({
        ...s,
        lastReviewedSha: mt.headSha || s.lastReviewedSha,
      }));
      return noopResult(target, cfg, start, mt.headSha);
    }

    // Post-materialize skips (#26). Applied to AUTO reviews only — an explicit
    // @warren command is a human override and always runs. Both advance
    // lastReviewedSha so a skipped head is not re-attempted every poll.
    if (event.reason !== "command") {
      const paths = mt.files.map((f) => f.path);
      if (cfg.autoReview.skipReleasePrs && isReleaseDiff(paths)) {
        deps.logger.info(`pipeline: ${key} is a release-only diff; skipping (skip_release_prs).`);
        await deps.state.setPrState(key, (s) => ({
          ...s,
          lastReviewedSha: mt.headSha || s.lastReviewedSha,
        }));
        return noopResult(target, cfg, start, mt.headSha);
      }
      const overBudget = budgetSkipReason(
        { fileCount: mt.files.length, diffChars: mt.diff.length },
        cfg.review,
      );
      if (overBudget) {
        deps.logger.warn(`pipeline: ${key} skipped — ${overBudget}.`);
        await deps.state.setPrState(key, (s) => ({
          ...s,
          lastReviewedSha: mt.headSha || s.lastReviewedSha,
        }));
        return noopResult(target, cfg, start, mt.headSha);
      }
    }

    const ctx = toPromptContext(mt, cfg);
    const slug = agentSlug(target);
    const client = deps.clientFor?.(target) ?? null;

    // SECURITY: resolve how much host access the agent gets on this UNTRUSTED checkout.
    // `static` (default) removes Bash entirely; `full`/`trusted` (per-author) allow it.
    const execution = resolveExecution(cfg, mt.context.author);
    if (execution === "full") {
      deps.logger.info(`pipeline: ${key} running review in FULL (Bash-enabled) execution mode.`);
    } else {
      deps.logger.debug(`pipeline: ${key} running review in STATIC (no-Bash) execution mode.`);
    }

    // 3. Triage pass — HOOK. Runs when review.effort=high (or deps.triage override).
    let walkthroughSkeleton = "";
    if (triageEnabled) {
      const triageName = `triage-${slug}`;
      await deps.fleet.addReviewAgent(
        triageAgentConfig({ name: triageName, workingDir: mt.checkoutDir, model: cfg.models.triage }),
      );
      const { text } = await runAgentTurn({
        fleet: deps.fleet,
        agentName: triageName,
        prompt: buildTriagePrompt(ctx),
        logger: deps.logger,
      });
      walkthroughSkeleton = text;
    }

    // 4. Review pass (agentic; findings come back via the github_pr MCP collector).
    const reviewerName = `reviewer-${slug}`;
    await deps.fleet.addReviewAgent(
      reviewerAgentConfig({
        name: reviewerName,
        workingDir: mt.checkoutDir,
        model: cfg.models.review,
        maxTurns: effort.reviewerMaxTurns,
        execution,
      }),
    );
    const reviewMcp = createGithubPrMcp({
      client,
      target,
      logger: deps.logger,
      lastReviewedSha: st.lastReviewedSha,
      existingFindings: [],
    });
    const reviewTurn = await runAgentTurn({
      fleet: deps.fleet,
      agentName: reviewerName,
      prompt: buildReviewPrompt(ctx),
      systemPromptAppend: buildReviewSystemAppend(cfg),
      injectedMcpServers: { github_pr: reviewMcp.def },
      logger: deps.logger,
    });

    const rawFindings = reviewMcp.collector.getFindings();
    const summary = reviewMcp.collector.getSummary();

    // If the review pass itself failed and produced nothing, do NOT advance state
    // (so the next poll retries) — SPEC §3.8 error rule.
    if (!reviewTurn.result.success && rawFindings.length === 0) {
      deps.logger.warn(`pipeline: review pass failed for ${key}; not advancing state.`);
      return noopResult(target, cfg, start, "");
    }

    // Effective severity floor: default `low`; assertive widens to `nit`.
    const minSev = effectiveMinSeverity(cfg);

    // 5. Verify pass — ONE batched turn over the severity-passing candidates only.
    const toVerify = rawFindings.filter((f) => meetsSeverity(f.severity, minSev));
    let survivors: Map<string, { keep: boolean; confidence: number }> | null = null;
    if (verifyEnabled && toVerify.length > 0) {
      survivors = await runVerifyPass(deps, mt, cfg, slug, toVerify, execution);
    }

    const candidates: Finding[] = rawFindings.map((rf) =>
      finalizeFinding(rf, minSev, verifyEnabled, survivors),
    );

    // 6. Gate + dedup (drops below-severity, unverified, low-confidence, duplicates).
    const posted = gateFindings(candidates, minSev, st.postedFingerprints);

    // Coverage signal: 0 findings should read as "looked, found nothing," not "gave up."
    const hunkCount = parseDiff(mt.diff).reduce((n, f) => n + f.hunks.length, 0);
    const coverageLine = buildCoverageLine({
      files: mt.files.length,
      hunks: hunkCount,
      verifyRan: verifyEnabled && toVerify.length > 0,
      findings: posted.length,
    });

    // Walkthrough: ALWAYS non-empty, but NEVER a mere copy of the summary (warren#1).
    // Prefer the agent's distinct walkthrough, then the triage skeleton; only fall back
    // to raw assistant text when there's no summary to carry the prose. We deliberately
    // do NOT fall back to `summary` here — the coverage line (appended below) keeps the
    // walkthrough non-empty, so a summary-only review renders its prose once (in Summary)
    // and a distinct coverage signal in Walkthrough, rather than the same paragraph twice.
    const walkthroughBody =
      reviewMcp.collector.getWalkthrough().trim() ||
      walkthroughSkeleton.trim() ||
      (summary.trim() ? "" : reviewTurn.text.trim());
    const walkthrough = composeWalkthrough(walkthroughBody, coverageLine);

    // 7. Sink: batched GitHub review, or a local markdown report.
    let stickyId: number | null = st.stickyCommentId;
    let resolvedFps: string[] = [];
    if (client && target.kind === "github-pr") {
      stickyId = await sinkToGithub(deps, client, target, mt, summary, walkthrough, posted, st.stickyCommentId);

      // 7b. Resolve-on-fix: a previously-posted finding NOT re-detected this run was
      // fixed by the author → resolve its review thread. "Still present" is judged by
      // the RAW detected fingerprints (ALL candidates, pre-gate), so a still-real but
      // gated/deduped finding is never mistaken for fixed. Dry-run captures the resolve.
      const resolveEnabled = deps.resolveOnFix ?? cfg.resolveOnFix;
      if (resolveEnabled && st.postedFingerprints.length > 0) {
        const detected = new Set(candidates.map((c) => c.fingerprint));
        const disappeared = new Set(st.postedFingerprints.filter((fp) => !detected.has(fp)));
        if (disappeared.size > 0) {
          resolvedFps = await resolveFixedThreads(deps, client, target, mt, disappeared);
        }
      }
    } else {
      await sinkToLocalReport(deps, target, key, mt, summary, walkthrough, posted);
    }

    // 8. Persist state (drop resolved fingerprints so a re-opened concern can re-post).
    // Capture the reviewer's herdctl session id so a later `@warren <question>` (ask.ts)
    // can RESUME this exact conversation — genuine continuity, not context reconstruction.
    // Only overwrite on a successful turn that yielded a session id; a failed/absent turn
    // keeps the prior (still-resumable) session.
    const reviewerSessionId =
      reviewTurn.result.success && reviewTurn.result.sessionId ? reviewTurn.result.sessionId : undefined;
    const newFps = posted.map((f) => f.fingerprint);
    const resolvedSet = new Set(resolvedFps);
    await deps.state.setPrState(key, (s) => ({
      ...s,
      lastReviewedSha: mt.headSha || s.lastReviewedSha,
      stickyCommentId: stickyId ?? s.stickyCommentId,
      reviewerSessionId: reviewerSessionId ?? s.reviewerSessionId,
      postedFingerprints: dedupe([...s.postedFingerprints, ...newFps]).filter(
        (fp) => !resolvedSet.has(fp),
      ),
    }));

    // 9. Result.
    const stats: ReviewStats = {
      filesReviewed: mt.files.length,
      hunksReviewed: hunkCount,
      findingsRaw: rawFindings.length,
      findingsVerified: candidates.filter((f) => f.verified).length,
      findingsPosted: posted.length,
      coverage: coverageLine,
      durationMs: Date.now() - start,
      triageModel: cfg.models.triage,
      reviewModel: cfg.models.review,
      verifyModel: cfg.models.verify,
    };
    const result: ReviewResult = {
      target,
      summary,
      walkthrough,
      findings: posted,
      stats,
      posted: posted.length > 0,
      sessionId: reviewTurn.result.success ? reviewTurn.result.sessionId : undefined,
    };

    // 10. Append to review history (dashboard). Best-effort: the store never
    // throws, but guard anyway so a history hiccup can't fail a real review.
    if (deps.history) {
      await deps.history.append(result).catch((err) => {
        deps.logger.warn(
          `pipeline: failed to append review history for ${key}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return result;
  } finally {
    await mt.dispose().catch(() => {});
  }
}

// ─────────────────────────── Verify pass ───────────────────────────

/**
 * ONE batched verify turn (JSON-verdict path). A verify agent inspects every candidate
 * and returns a JSON ARRAY of `{ id, keep, confidence, reason }` verdicts as TEXT (no
 * MCP tool call in the verify turn). We parse that text, map verdicts back to candidates
 * by fingerprint, and FAIL OPEN: any candidate lacking a parseable verdict is kept at a
 * low confidence so a flaky/garbled verify turn can never silently drop everything.
 */
async function runVerifyPass(
  deps: ReviewPipelineDeps,
  mt: MaterializedTarget,
  cfg: WarrenConfig,
  slug: string,
  findings: RawFinding[],
  execution: "static" | "full",
): Promise<Map<string, { keep: boolean; confidence: number }>> {
  const verifyName = `verify-${slug}`;
  await deps.fleet.addReviewAgent(
    verifyAgentConfig({
      name: verifyName,
      workingDir: mt.checkoutDir,
      model: cfg.models.verify,
      execution,
    }),
  );
  const ctx = toPromptContext(mt, cfg);
  const { text } = await runAgentTurn({
    fleet: deps.fleet,
    agentName: verifyName,
    prompt: buildBatchVerifyPrompt(findings, ctx),
    logger: deps.logger,
  });

  // Fail-open baseline: every candidate keeps at low confidence unless a verdict overrides.
  const survivors = new Map<string, { keep: boolean; confidence: number }>();
  for (const f of findings) {
    survivors.set(fingerprint(f), { keep: true, confidence: FAIL_OPEN_CONFIDENCE });
  }

  const verdicts = parseVerifyVerdicts(text);
  if (!verdicts) {
    deps.logger.warn(
      `pipeline: verify pass returned no parseable verdict JSON for ${slug}; failing open (keeping ${findings.length} candidate(s) at low confidence).`,
    );
    return survivors;
  }

  const byFp = new Map(findings.map((f) => [fingerprint(f), f] as const));
  for (const v of verdicts) {
    const fp = matchVerdictFp(v, byFp);
    if (!fp) continue;
    survivors.set(fp, {
      keep: v.keep !== false, // default keep unless explicitly refuted
      confidence: clampConfidence(v.confidence, v.keep === false ? 0 : FAIL_OPEN_CONFIDENCE),
    });
  }
  return survivors;
}

/** Confidence used when a candidate keeps but has no explicit verify score (>= gate min). */
const FAIL_OPEN_CONFIDENCE = 0.5;

interface VerifyVerdict {
  id?: unknown;
  fingerprint?: unknown;
  keep?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

/** Match a verdict's id/fingerprint field to a known candidate fingerprint. */
function matchVerdictFp(v: VerifyVerdict, byFp: Map<string, RawFinding>): string | null {
  for (const raw of [v.id, v.fingerprint]) {
    if (typeof raw === "string" && byFp.has(raw)) return raw;
  }
  return null;
}

/** Coerce a verdict `confidence` into 0..1, falling back to `dflt` when absent/invalid. */
function clampConfidence(c: unknown, dflt: number): number {
  const n = typeof c === "number" ? c : typeof c === "string" ? Number(c) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(1, Math.max(0, n));
}

/**
 * Robustly extract the JSON verdict ARRAY from an agent's free-form text: strip Markdown
 * code fences and surrounding prose, then parse the first balanced `[`…`]` span. Returns
 * null when nothing parseable is found (caller fails open).
 */
export function parseVerifyVerdicts(text: string): VerifyVerdict[] | null {
  if (!text) return null;
  const candidates: string[] = [];

  // Prefer a fenced ```json … ``` block if present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fence.exec(text)) !== null) candidates.push(fm[1]);
  // Fall back to scanning the whole text for a bracketed array.
  candidates.push(text);

  for (const chunk of candidates) {
    const span = firstArraySpan(chunk);
    if (!span) continue;
    try {
      const parsed = JSON.parse(span);
      if (Array.isArray(parsed)) return parsed as VerifyVerdict[];
    } catch {
      // try the next candidate chunk
    }
  }
  return null;
}

/** Return the first balanced `[`…`]` substring of `s`, honoring quotes/escapes, or null. */
function firstArraySpan(s: string): string | null {
  const start = s.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// ─────────────────────────── Finding finalization ───────────────────────────

/** Stamp fingerprint/verified/confidence onto a RawFinding using verify verdicts. */
function finalizeFinding(
  rf: RawFinding,
  minSeverity: Severity,
  verifyEnabled: boolean,
  survivors: Map<string, { keep: boolean; confidence: number }> | null,
): Finding {
  const fp = fingerprint(rf);
  let verified: boolean;
  let confidence: number;

  if (!verifyEnabled) {
    verified = true;
    confidence = rf.confidence ?? 0.8;
  } else if (!meetsSeverity(rf.severity, minSeverity)) {
    // Below threshold — never verified; gate drops it on severity anyway.
    verified = false;
    confidence = rf.confidence ?? 0;
  } else {
    const v = survivors?.get(fp);
    verified = v?.keep ?? false;
    confidence = v?.confidence ?? rf.confidence ?? 0;
  }

  return { ...rf, confidence, fingerprint: fp, verified };
}

// ─────────────────────────── Sinks ───────────────────────────

/** Build one batched GitHub review + upsert the sticky walkthrough. Returns sticky id. */
async function sinkToGithub(
  deps: ReviewPipelineDeps,
  client: GitHubClient,
  target: Extract<ReviewTarget, { kind: "github-pr" }>,
  mt: MaterializedTarget,
  summary: string,
  walkthrough: string,
  posted: Finding[],
  knownStickyId: number | null,
): Promise<number | null> {
  const hunks = parseDiff(mt.diff);
  const comments: ReviewSubmission["comments"] = [];
  for (const f of posted) {
    const mapped = mapFindingToHunk({ path: f.path, line: f.line, endLine: f.endLine, side: f.side }, hunks);
    if (!mapped) {
      deps.logger.debug(`pipeline: dropping off-diff finding ${f.path}:${f.line}`);
      continue;
    }
    comments.push({
      path: f.path,
      body: commentBody(f),
      line: mapped.line,
      side: mapped.side,
      ...(mapped.startLine != null ? { startLine: mapped.startLine, startSide: mapped.startSide } : {}),
    });
  }

  const review: ReviewSubmission = {
    commitId: mt.headSha,
    body: summary || "Warren review.",
    event: "COMMENT",
    comments,
  };
  const outcome = await client.createReview(target.repo, target.prNumber, review);
  deps.logger.info(`pipeline: review ${outcome.dryRun ? "captured (dry-run)" : "posted"} (${comments.length} comments).`);

  let stickyId = knownStickyId;
  if (walkthrough) {
    const sticky = await client.upsertStickyComment(
      target.repo,
      target.prNumber,
      WALKTHROUGH_MARKER,
      walkthrough,
      knownStickyId,
    );
    if (typeof sticky.ref === "number") stickyId = sticky.ref;
  }
  return stickyId;
}

/**
 * Resolve-on-fix (SPEC §3.8, M2). Fetch the PR's review threads, recover each thread's
 * finding fingerprint from the hidden marker in its first comment, and resolve every
 * UNRESOLVED thread whose fingerprint is in `disappeared` (previously posted, not detected
 * this run). Returns the fingerprints actually resolved so the caller can prune them.
 *
 * Path guard: re-reviews are incremental and only re-examine files changed since the last
 * review, so a thread anchored to a file we did NOT re-review this run is skipped — its
 * finding may simply be untouched, not fixed. Live resolves the thread; dry-run captures it.
 */
async function resolveFixedThreads(
  deps: ReviewPipelineDeps,
  client: GitHubClient,
  target: Extract<ReviewTarget, { kind: "github-pr" }>,
  mt: MaterializedTarget,
  disappeared: Set<string>,
): Promise<string[]> {
  let threads;
  try {
    threads = await client.listReviewThreads(target.repo, target.prNumber);
  } catch (err) {
    deps.logger.warn(
      `pipeline: resolve-on-fix skipped (could not fetch review threads): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const reviewedPaths = new Set(mt.files.map((f) => f.path));
  const resolved: string[] = [];
  for (const t of threads) {
    if (t.isResolved) continue;
    // Only conclude "fixed" for a file we actually re-reviewed this run.
    if (t.path != null && !reviewedPaths.has(t.path)) continue;
    const fp = t.firstCommentBody ? decodeFindingMarker(t.firstCommentBody) : null;
    if (!fp || !disappeared.has(fp)) continue;

    const outcome = await client.resolveThread(target.repo, t.id);
    resolved.push(fp);
    deps.logger.info(
      `pipeline: resolve-on-fix ${
        outcome.dryRun ? "captured (dry-run)" : "resolved"
      } thread ${t.id} for fixed finding ${fp}.`,
    );
  }
  return resolved;
}

/** Render + write a local markdown review report; returns the file path. */
async function sinkToLocalReport(
  deps: ReviewPipelineDeps,
  target: ReviewTarget,
  key: string,
  mt: MaterializedTarget,
  summary: string,
  walkthrough: string,
  posted: Finding[],
): Promise<string> {
  const dir = path.join(deps.dataDir, "reviews");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sanitize(key)}-${mt.headSha || "head"}.md`);
  await fs.writeFile(file, renderReport(target, mt, summary, walkthrough, posted), "utf8");
  deps.logger.info(`pipeline: wrote local review report → ${file}`);
  return file;
}

function renderReport(
  target: ReviewTarget,
  mt: MaterializedTarget,
  summary: string,
  walkthrough: string,
  posted: Finding[],
): string {
  const lines: string[] = [
    `# Warren review — ${targetKey(target)}`,
    "",
    `head: \`${mt.headSha}\`  base: \`${mt.baseSha}\``,
    "",
    "## Summary",
    summary || "_(none)_",
  ];
  if (walkthrough) lines.push("", "## Walkthrough", walkthrough);
  lines.push("", `## Findings (${posted.length})`);
  if (posted.length === 0) {
    lines.push("_(no findings after gate)_");
  } else {
    for (const f of posted) {
      lines.push(
        "",
        `### ${f.severity.toUpperCase()} · ${f.category} — ${f.title}`,
        `\`${f.path}:${f.line}${f.endLine ? `-${f.endLine}` : ""}\` (${f.side}) · confidence ${f.confidence.toFixed(2)}`,
        "",
        f.body,
      );
      if (f.suggestion) lines.push("", buildSuggestionBlock(f.suggestion));
      lines.push("", encodeFindingMarker(f.fingerprint));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Comment body for a posted GitHub review comment: prose + suggestion + hidden marker. */
function commentBody(f: Finding): string {
  const parts = [`**${f.severity.toUpperCase()} · ${f.category}** — ${f.title}`, "", f.body];
  if (f.suggestion) parts.push("", buildSuggestionBlock(f.suggestion));
  parts.push("", encodeFindingMarker(f.fingerprint));
  return parts.join("\n");
}

// ─────────────────────────── Helpers ───────────────────────────

function noopResult(target: ReviewTarget, cfg: WarrenConfig, start: number, headSha: string): ReviewResult {
  return {
    target,
    summary: "",
    walkthrough: "",
    findings: [],
    stats: {
      filesReviewed: 0,
      hunksReviewed: 0,
      findingsRaw: 0,
      findingsVerified: 0,
      findingsPosted: 0,
      coverage: "",
      durationMs: Date.now() - start,
      triageModel: cfg.models.triage,
      reviewModel: cfg.models.review,
      verifyModel: cfg.models.verify,
    },
    posted: false,
    sessionId: undefined,
  };
  void headSha;
}

/**
 * One-line coverage signal rendered into the walkthrough so a 0-finding review reads
 * as "looked, found nothing," not "gave up." e.g.
 * `Reviewed 3 changed files (7 hunks); ran the verify pass; 0 findings.`
 */
function buildCoverageLine(opts: {
  files: number;
  hunks: number;
  verifyRan: boolean;
  findings: number;
}): string {
  const f = `${opts.files} changed file${opts.files === 1 ? "" : "s"}`;
  const h = `${opts.hunks} hunk${opts.hunks === 1 ? "" : "s"}`;
  const verify = opts.verifyRan ? "; ran the verify pass" : "";
  const n = `${opts.findings} finding${opts.findings === 1 ? "" : "s"}`;
  return `Reviewed ${f} (${h})${verify}; ${n}.`;
}

/** Combine the walkthrough body with the coverage line; always non-empty. */
function composeWalkthrough(body: string, coverage: string): string {
  const b = body.trim();
  return b ? `${b}\n\n${coverage}` : coverage;
}

function agentSlug(target: ReviewTarget): string {
  return sanitize(targetKey(target)).slice(0, 48).toLowerCase() || "target";
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "_");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// Re-export the seam types so callers can import them from the pipeline module.
export type { MaterializedTarget, PrFile };
