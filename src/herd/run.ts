// src/herd/run.ts — a thin helper around fleet.trigger for a single agent turn.
//
// `runAgentTurn` fires one turn on an agent, streams the assistant's text into a
// concise accumulated log (also surfaced live via `onProgress`), and returns both
// the raw TriggerResult and the collected text. It deliberately does NOT read any
// findings — those are collected out-of-band by the injected github_pr MCP's
// FindingCollector, which the pipeline reads after this resolves.
//
// We stringify assistant text ourselves (rather than pulling in @herdctl/chat's
// createSDKMessageHandler) to keep this dependency-light; the herdctl SDKMessage
// shape is loose (`[key: string]: unknown`), so extraction is defensive.

import type { InjectedMcpServerDef, SDKMessage, TriggerResult } from "@herdctl/core";
import type { Logger, TokenUsage } from "../types.js";
import { addUsage, emptyUsage, extractUsage } from "../review/usage.js";
import type { FleetWrapper } from "./fleet.js";

export interface RunAgentTurnArgs {
  fleet: FleetWrapper;
  agentName: string;
  prompt: string;
  /** Injected in-process MCP servers. Record KEY is the tool namespace (`mcp__<key>__*`). */
  injectedMcpServers?: Record<string, InjectedMcpServerDef>;
  /** Per-trigger system-prompt suffix (Warren's hardening + review rules). */
  systemPromptAppend?: string;
  /** string = resume that session; null = force NEW; undefined = agent fallback. */
  resume?: string | null;
  logger?: Logger;
  /** Called with each chunk of assistant text as it streams. */
  onProgress?: (text: string) => void;
  /** Fires with the job id mid-flight (enables cancel/supersede upstream). */
  onJobCreated?: (jobId: string) => void | Promise<void>;
}

export interface RunAgentTurnResult {
  result: TriggerResult;
  /** Concatenated assistant text emitted during the turn (for logging/summaries). */
  text: string;
  /** REAL token usage for this turn (see review/usage.ts). Zero if the SDK reported none. */
  usage: TokenUsage;
}

/**
 * Run one agent turn and return its result + a concise text transcript. Small by
 * design — the pipeline owns pass sequencing; this only wraps a single trigger.
 */
export async function runAgentTurn(args: RunAgentTurnArgs): Promise<RunAgentTurnResult> {
  const { fleet, agentName, logger } = args;
  const chunks: string[] = [];

  const record = (text: string): void => {
    if (!text) return;
    chunks.push(text);
    args.onProgress?.(text);
    logger?.debug(`[${agentName}] ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
  };

  // Token accounting. The SDK's own `result` message carries the authoritative
  // aggregate (input+output on the CLI runtime; full breakdown on an SDK runtime), so
  // prefer it. As a fallback — should a `result` message not surface via onMessage — we
  // sum the per-turn `assistant` usages, which equals the same total. We never ADD both
  // (result IS the sum of the assistant turns), so there's no double counting.
  let resultUsage: TokenUsage | null = null;
  let assistantSum = emptyUsage();

  const result = await fleet.trigger(agentName, {
    prompt: args.prompt,
    resume: args.resume,
    injectedMcpServers: args.injectedMcpServers,
    systemPromptAppend: args.systemPromptAppend,
    onJobCreated: args.onJobCreated,
    onMessage: (m: SDKMessage) => {
      if (m?.type === "assistant") {
        for (const t of extractAssistantText(m)) record(t);
        const u = extractUsage(m);
        if (u) assistantSum = addUsage(assistantSum, u);
      } else if (m?.type === "result") {
        const u = extractUsage(m);
        if (u) resultUsage = u;
      }
    },
  });

  return { result, text: chunks.join("\n"), usage: resultUsage ?? assistantSum };
}

/** Pull any assistant-visible text out of a (loosely-typed) herdctl SDKMessage. */
function extractAssistantText(m: SDKMessage): string[] {
  if (!m || m.type !== "assistant") return [];
  const out: string[] = [];

  // Preferred: the nested API message content blocks.
  const message = m.message as { content?: unknown } | undefined;
  const blocks = message?.content;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b && typeof b === "object") {
        const block = b as { type?: unknown; text?: unknown };
        if (block.type === "text" && typeof block.text === "string") out.push(block.text);
      }
    }
  } else if (typeof blocks === "string") {
    out.push(blocks);
  }

  // Fallback: a top-level `content` string on some message variants.
  if (out.length === 0 && typeof m.content === "string") out.push(m.content);
  return out;
}
