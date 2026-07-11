// @warren command parser (SPEC §6, module map: trigger/commands.ts). Pure.
//
// A comment is a command if its first non-empty line starts with the bot mention
// (`@warren`, or `@<botLogin>`), case-insensitively, followed by a recognized verb.
// Longest match first so "full review" beats "review". Comments authored by the bot
// itself are ignored to avoid feedback loops (the bot's help text lists these verbs).

import type { WarrenCommand, WarrenCommandKind } from "../types.js";
import type { IssueComment } from "../github/client.js";

/** Verb table, ordered longest-match-first. */
const VERBS: Array<{ re: RegExp; kind: WarrenCommandKind }> = [
  { re: /^full\s+review\b/i, kind: "full_review" },
  { re: /^review\b/i, kind: "review" },
  { re: /^pause\b/i, kind: "pause" },
  { re: /^resume\b/i, kind: "resume" },
  { re: /^resolve\b/i, kind: "resolve" },
  { re: /^help\b/i, kind: "help" },
];

const DEFAULT_MENTION = "warren";

function firstNonEmptyLine(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/**
 * Parse a command kind from a raw comment body. Recognizes `@warren <verb>` and, when a
 * `botLogin` is supplied, `@<botLogin> <verb>`. Returns null for anything unrecognized.
 */
function parseKind(body: string, botLogin?: string): WarrenCommandKind | null {
  const line = firstNonEmptyLine(body);
  if (!line) return null;

  const mentions = [DEFAULT_MENTION];
  if (botLogin && botLogin.trim().length > 0) mentions.push(botLogin.trim());
  // Longest mention first so "@warren-bot" wins over the "@warren" prefix.
  mentions.sort((a, b) => b.length - a.length);

  const lower = line.toLowerCase();
  let rest: string | null = null;
  for (const m of mentions) {
    const mention = `@${m.toLowerCase()}`;
    if (!lower.startsWith(mention)) continue;
    // The mention must be a whole token: followed by whitespace/`:`/`,` or end of line
    // (so "@warren-bot" is NOT matched by the "@warren" mention).
    const after = line.slice(mention.length);
    if (after.length > 0 && !/^[\s:,]/.test(after)) continue;
    rest = after.replace(/^[\s:,]+/, "");
    break;
  }
  if (rest === null) return null;

  for (const { re, kind } of VERBS) {
    if (re.test(rest)) return kind;
  }
  return null;
}

/**
 * Parse a bare comment body into a WarrenCommand. Does NOT perform author (bot-loop)
 * filtering — it has no author to inspect; use `parseWarrenCommand` for that. `botLogin`
 * is accepted as an additional mention token (`@<botLogin> review`).
 */
export function parseCommand(body: string, botLogin?: string): WarrenCommand | null {
  const kind = parseKind(body, botLogin);
  if (!kind) return null;
  return { kind, raw: body };
}

/**
 * Parse a PR conversation comment into a WarrenCommand (the SPEC §6 poll-mode seam).
 * Returns null for non-commands and for comments authored by the bot itself.
 */
export function parseWarrenCommand(
  comment: IssueComment,
  botLogin?: string,
): WarrenCommand | null {
  // Ignore the bot's own comments to avoid parsing its help text as commands.
  if (botLogin && comment.author && comment.author.toLowerCase() === botLogin.toLowerCase()) {
    return null;
  }
  const kind = parseKind(comment.body, botLogin);
  if (!kind) return null;
  return { kind, raw: comment.body, commentId: comment.id, author: comment.author };
}
