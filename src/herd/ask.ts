// src/herd/ask.ts — the conversational `@warren <question>` handler (M3).
//
// This is Warren's differentiator vs a stateless reviewer: instead of reconstructing
// context from scratch, it RESUMES the PR's reviewer Claude session (by the session id
// captured in PrState during the review) and answers the follow-up with genuine
// continuity — the diff, the findings, and the reasoning are already in the conversation.
//
// Flow (all server-side; the agent never holds a credential):
//   1. Load PrState → the reviewer session id + the already-answered comment ids.
//   2. Dedup: a comment id already answered is a no-op (poll can re-see it on restart).
//   3. Re-materialize the target so a checkout exists at the SAME deterministic path the
//      reviewer used — Claude Code keys transcripts by cwd, so resume only resolves the
//      transcript when cwd matches (§ "resume" in @herdctl/core types).
//   4. Run ONE ask-agent turn: resume=sessionId (genuine) or, when there is no session,
//      resume=null with the PR context reconstructed into the prompt (documented fallback).
//   5. Post the agent's TEXT answer back as the reply (in-thread for a review comment,
//      else a new PR conversation comment). Dry-run captures it instead of posting.
//   6. Record the comment id in `answeredCommentIds` so it is never answered twice.

import type { GitHubClient } from "../github/client.js";
import type { ReviewStateStore } from "../state/store.js";
import { targetKey, type Logger, type ReviewTarget, type WarrenCommand, type WarrenConfig } from "../types.js";
import type { FleetWrapper } from "./fleet.js";
import { runAgentTurn } from "./run.js";
import { askAgentConfig } from "./reviewer.js";
import type { ReviewTargetProvider } from "../review/target.js";
import { buildAskPrompt, buildAskSystemAppend, toPromptContext } from "../review/prompts.js";

export interface AskHandlerDeps {
  fleet: FleetWrapper;
  provider: ReviewTargetProvider;
  state: ReviewStateStore;
  /** GitHub client for a target (dry-run gated); null → cannot post, ask is skipped. */
  clientFor?: (t: ReviewTarget) => GitHubClient | null;
  /** Resolve the effective WarrenConfig for a target. */
  config: (t: ReviewTarget) => WarrenConfig;
  logger: Logger;
}

export interface AskRequest {
  target: ReviewTarget;
  command: WarrenCommand; // kind === "ask"
}

export interface AskResult {
  answered: boolean;
  /** Why the ask was not answered (dedup / no-client / no-question / error / not-github). */
  reason?: string;
  /** The answer text produced by the agent (before reply formatting). */
  answer?: string;
  /** The session id that was resumed (undefined when the fallback ran a fresh session). */
  resumedSession?: string;
}

/**
 * Handle one `@warren <question>` ask. Never throws — failures are logged and returned as
 * `{ answered: false, reason }` so a poll tick is never crashed by a bad question/turn.
 */
export async function handleAsk(deps: AskHandlerDeps, req: AskRequest): Promise<AskResult> {
  const { target, command } = req;
  const { logger } = deps;

  // Asks only make sense on a GitHub PR (a local-git target has no comment stream).
  if (target.kind !== "github-pr") return { answered: false, reason: "not-github-pr" };

  const question = (command.question ?? "").trim();
  if (!question) return { answered: false, reason: "empty-question" };

  const key = targetKey(target);
  const commentId = command.commentId ?? null;

  // Dedup BEFORE doing any expensive work: an already-answered comment is a no-op.
  const st = await deps.state.getPrState(key);
  if (commentId != null && st.answeredCommentIds.includes(commentId)) {
    logger.debug(`ask: comment ${commentId} on ${key} already answered; skipping.`);
    return { answered: false, reason: "already-answered" };
  }

  const client = deps.clientFor?.(target) ?? null;
  if (!client) {
    logger.warn(`ask: no GitHub client for ${key}; cannot post an answer.`);
    return { answered: false, reason: "no-client" };
  }

  const cfg = deps.config(target);
  const sessionId = st.reviewerSessionId && st.reviewerSessionId.length > 0 ? st.reviewerSessionId : null;
  const resumed = sessionId != null;

  // Re-materialize so the checkout exists at the SAME path the reviewer used (resume keys
  // transcripts by cwd). full:true guarantees a checkout at head even with no new commits.
  const mt = await deps.provider.materialize(target, { full: true, sinceSha: "" });
  try {
    const slug = sanitize(key).slice(0, 48).toLowerCase() || "target";
    const agentName = `ask-${slug}`;
    await deps.fleet.addReviewAgent(
      askAgentConfig({ name: agentName, workingDir: mt.checkoutDir, model: cfg.models.review }),
    );

    const prompt = buildAskPrompt(question, {
      resumed,
      asker: command.author,
      ...(resumed ? {} : { ctx: toPromptContext(mt, cfg) }),
    });

    const turn = await runAgentTurn({
      fleet: deps.fleet,
      agentName,
      prompt,
      resume: sessionId, // string = resume that session; null = fresh (fallback)
      systemPromptAppend: buildAskSystemAppend(),
      logger,
    });

    const answer = turn.text.trim();
    if (!turn.result.success || answer.length === 0) {
      logger.warn(`ask: agent produced no answer for comment ${commentId ?? "?"} on ${key}.`);
      return { answered: false, reason: "no-answer" };
    }

    // Post the reply server-side. In-thread for a diff (review) comment; otherwise a new
    // PR conversation comment addressed to the asker.
    const body = formatReply(answer, command);
    let outcome;
    if (command.commentKind === "review" && commentId != null) {
      outcome = await client.replyToThread(target.repo, target.prNumber, commentId, body);
    } else {
      outcome = await client.postIssueComment(target.repo, target.prNumber, body);
    }
    logger.info(
      `ask: ${outcome.dryRun ? "captured (dry-run)" : "posted"} answer on ${key}` +
        `${resumed ? ` (resumed session ${sessionId})` : " (fresh session — no prior review)"}.`,
    );

    // Mark the comment answered so it is never answered again.
    if (commentId != null) {
      await deps.state.setPrState(key, (s) => ({
        ...s,
        answeredCommentIds: dedupeNums([...s.answeredCommentIds, commentId]),
      }));
    }

    return { answered: true, answer, ...(resumed && sessionId ? { resumedSession: sessionId } : {}) };
  } catch (err) {
    logger.warn(`ask: failed on ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return { answered: false, reason: "error" };
  } finally {
    await mt.dispose().catch(() => {});
  }
}

/** Format the answer into the reply body. Review-thread replies stay inline; a new PR
 *  conversation comment is addressed to the asker so it reads as a reply. */
function formatReply(answer: string, command: WarrenCommand): string {
  if (command.commentKind === "review") return answer;
  const mention = command.author ? `@${command.author} ` : "";
  return `${mention}${answer}`;
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, "_");
}

function dedupeNums(items: number[]): number[] {
  return [...new Set(items)];
}
