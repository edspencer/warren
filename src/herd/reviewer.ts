// src/herd/reviewer.ts — pure agent-config factories for Warren's review passes.
//
// These functions build the plain object literals passed to
// `FleetManager.addAgent(...)` (via fleet.addReviewAgent). They register NOTHING
// themselves — the pipeline/fleet wrapper owns registration, so these stay pure
// and trivially testable (no FleetManager, no I/O).
//
// Three passes, three models (herdctl has NO per-trigger model override — only
// `setModel` on openChatSession — so each pass is its own agent, per research/05
// §2 + the Warren spec §4.2):
//   • reviewer — the agentic reviewer (Opus). Full tool set + github_pr MCP.
//   • triage   — cheap Haiku pre-pass. Read-only tools + github_pr MCP.
//   • verify   — cheap Haiku adversarial refuter. Evidence tools + github_pr MCP.
//
// CRITICAL FACTS (from a passing spike — obey exactly):
//   • runtime MUST be "cli" PER AGENT — the fleet `defaults.runtime` is dropped
//     by core's config loader, so without this the runner silently falls back to
//     the SDK runtime (wrong billing path).
//   • allowed_tools MUST explicitly include "mcp__github_pr__*". herdctl only
//     auto-allowlists an injected MCP server (`mcp__<key>__*`) when the agent
//     ALREADY has an explicit allowed_tools list — which these provide.
//   • ToolSearch is included wherever github_pr is reachable: on the CLI runtime
//     the agent spends 1–2 turns discovering the injected MCP tool via ToolSearch
//     before it can call it, so max_turns is kept comfortably ≥ 8.

/** Model ids proven to work in the spike. Opus for review, Haiku for cheap passes. */
export const REVIEW_MODEL = "claude-opus-4-8";
export const CHEAP_MODEL = "claude-haiku-4-5-20251001";

/** The injected-MCP allowlist pattern. Record key MUST be "github_pr" at trigger time. */
export const GITHUB_PR_MCP = "mcp__github_pr__*";

/**
 * Guardrails applied to every pass. The reviewer never writes to the repo and
 * never has a credentialed egress path (its ONLY write channel is the injected
 * github_pr MCP server, whose handlers run in Warren's process).
 */
export const REVIEWER_DENIED_TOOLS = [
  "Bash(sudo *)",
  "Bash(rm -rf /)",
  "Bash(rm -rf /*)",
  "Bash(chmod 777 *)",
  "Bash(git push *)",
  "Bash(gh *)",
  "Write",
  "Edit",
];

/** An agent-config object literal, as consumed by `FleetManager.addAgent`. */
export type ReviewerAgentConfig = Record<string, unknown> & { name: string };

/** Common inputs for every pass factory; `model`/`maxTurns` override the defaults. */
export interface AgentConfigParams {
  /** Deterministic agent name, e.g. `reviewer-<slug>`. removeAgent uses the same. */
  name: string;
  /** Absolute checkout dir at head SHA — the agent's cwd AND its session key. */
  workingDir: string;
  /** Override the pass's default model (from WarrenConfig.models.*). */
  model?: string;
  /** Override the pass's default turn budget. */
  maxTurns?: number;
  /** Optional per-repo parallelism; defaults to 4 so concurrent PRs don't throw. */
  maxConcurrent?: number;
}

/**
 * The agentic reviewer (Opus by default). Reads/greps/globs/bashes the checkout,
 * spawns Task subagents, and reports findings via `mcp__github_pr__post_review`
 * + `mcp__github_pr__update_walkthrough`. No system_prompt override → keeps the
 * Claude Code default coding prompt + CLAUDE.md; Warren appends review rules via
 * TriggerOptions.systemPromptAppend at trigger time.
 */
export function reviewerAgentConfig(params: AgentConfigParams): ReviewerAgentConfig {
  const { name, workingDir, model = REVIEW_MODEL, maxTurns = 30, maxConcurrent = 4 } = params;
  return {
    name,
    description: `Warren agentic PR reviewer (${name}).`,
    working_directory: workingDir,
    runtime: "cli",
    model,
    permission_mode: "acceptEdits",
    max_turns: maxTurns,
    instances: { max_concurrent: maxConcurrent },
    allowed_tools: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Task",
      "TodoWrite",
      "ToolSearch",
      GITHUB_PR_MCP,
    ],
    denied_tools: REVIEWER_DENIED_TOOLS,
    default_prompt: "Review the current diff.",
  };
}

/**
 * Cheap triage pre-pass (Haiku by default). Summarizes per-file changes, picks
 * review depth, drafts the walkthrough skeleton. Read-only tool set so it can
 * look at the diff/context without editing or running the repo.
 */
export function triageAgentConfig(params: AgentConfigParams): ReviewerAgentConfig {
  const { name, workingDir, model = CHEAP_MODEL, maxTurns = 12, maxConcurrent = 4 } = params;
  return {
    name,
    description: `Warren triage pass (${name}).`,
    working_directory: workingDir,
    runtime: "cli",
    model,
    permission_mode: "acceptEdits",
    max_turns: maxTurns,
    instances: { max_concurrent: maxConcurrent },
    allowed_tools: ["Read", "Grep", "Glob", "ToolSearch", GITHUB_PR_MCP],
    denied_tools: REVIEWER_DENIED_TOOLS,
    default_prompt: "Triage the current diff.",
  };
}

/**
 * Cheap adversarial verify pass (Haiku by default). Gathers evidence to REFUTE a
 * proposed finding — Read/Grep/Glob to inspect code, Bash to run cheap offline
 * checks (lint/tests) — then reports a keep/drop verdict.
 */
export function verifyAgentConfig(params: AgentConfigParams): ReviewerAgentConfig {
  const { name, workingDir, model = CHEAP_MODEL, maxTurns = 15, maxConcurrent = 4 } = params;
  return {
    name,
    description: `Warren verify pass (${name}).`,
    working_directory: workingDir,
    runtime: "cli",
    model,
    permission_mode: "acceptEdits",
    max_turns: maxTurns,
    instances: { max_concurrent: maxConcurrent },
    allowed_tools: ["Read", "Grep", "Glob", "Bash", "ToolSearch", GITHUB_PR_MCP],
    denied_tools: REVIEWER_DENIED_TOOLS,
    default_prompt: "Verify the proposed findings.",
  };
}
