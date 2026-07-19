// @warren command parser (SPEC §6, module map: trigger/commands.ts). Pure.
//
// A comment is a command if its first non-empty line starts with the bot mention
// (`@warren`, or `@<botLogin>`), case-insensitively. If the mention is followed by a
// recognized VERB (longest match first, so "full review" beats "review") that verb is
// the command. If the mention is followed by any OTHER non-empty text, it is a free-form
// `ask` (conversational Q&A) whose `question` is the text after the mention. A BARE
// mention (nothing after it) is NOT a command. Comments authored by the bot itself are
// ignored to avoid feedback loops (the bot's help text lists these verbs).

import type { WarrenCommand, WarrenCommandKind } from "../types.js";
import type { IssueComment } from "../github/client.js";

/** Verb table, ordered longest-match-first. `ask` is NOT here — it's the fallback. */
const VERBS: Array<{ re: RegExp; kind: WarrenCommandKind }> = [
  { re: /^full\s+review\b/i, kind: "full_review" },
  { re: /^review\b/i, kind: "review" },
  { re: /^pause\b/i, kind: "pause" },
  { re: /^resume\b/i, kind: "resume" },
  { re: /^resolve\b/i, kind: "resolve" },
  { re: /^help\b/i, kind: "help" },
];

const DEFAULT_MENTION = "warren";

/** The text following the mention: `firstLineRest` drives verb detection, `fullRest`
 *  (spanning subsequent lines) is the free-form question. Null = no mention present. */
interface MentionRest {
  firstLineRest: string;
  fullRest: string;
}

/**
 * Strip the leading bot mention off a comment body. Returns the remainder text, or null
 * when the first non-empty line does not START with `@warren`/`@<botLogin>` as a whole
 * token (so "please @warren review" and "@warren-bot" under the "@warren" mention are
 * NOT matched).
 */
function stripMention(body: string, botLogin?: string): MentionRest | null {
  const lines = body.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].trim().length > 0) break;
  }
  if (i >= lines.length) return null;
  const line = lines[i].trim();

  const mentions = [DEFAULT_MENTION];
  if (botLogin && botLogin.trim().length > 0) mentions.push(botLogin.trim());
  // Longest mention first so "@warren-bot" wins over the "@warren" prefix.
  mentions.sort((a, b) => b.length - a.length);

  const lower = line.toLowerCase();
  for (const m of mentions) {
    const mention = `@${m.toLowerCase()}`;
    if (!lower.startsWith(mention)) continue;
    // The mention must be a whole token: followed by whitespace/`:`/`,` or end of line.
    const after = line.slice(mention.length);
    if (after.length > 0 && !/^[\s:,]/.test(after)) continue;
    const firstLineRest = after.replace(/^[\s:,]+/, "");
    const fullRest = [firstLineRest, ...lines.slice(i + 1)].join("\n").trim();
    return { firstLineRest, fullRest };
  }
  return null;
}

/** Result of parsing a mention: a verb command, a free-form ask, or nothing. */
interface ParsedCommand {
  kind: WarrenCommandKind;
  question?: string;
}

/**
 * Parse a mention into a verb command or a free-form ask. Returns null when there is no
 * mention, or when the mention is BARE (no text after it — not a command, not a question).
 */
function parseKind(body: string, botLogin?: string): ParsedCommand | null {
  const rest = stripMention(body, botLogin);
  if (!rest) return null;

  for (const { re, kind } of VERBS) {
    if (re.test(rest.firstLineRest)) return { kind };
  }
  // Not a known verb: a mention followed by free-form text is a conversational ask.
  if (rest.fullRest.length > 0) return { kind: "ask", question: rest.fullRest };
  return null; // bare mention — ignore
}

/**
 * Parse a bare comment body into a WarrenCommand. Does NOT perform author (bot-loop)
 * filtering — it has no author to inspect; use `parseWarrenCommand` for that. `botLogin`
 * is accepted as an additional mention token (`@<botLogin> review`).
 */
export function parseCommand(body: string, botLogin?: string): WarrenCommand | null {
  const parsed = parseKind(body, botLogin);
  if (!parsed) return null;
  return { kind: parsed.kind, raw: body, ...(parsed.question ? { question: parsed.question } : {}) };
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
  const parsed = parseKind(comment.body, botLogin);
  if (!parsed) return null;
  return {
    kind: parsed.kind,
    raw: comment.body,
    commentId: comment.id,
    author: comment.author,
    ...(parsed.question ? { question: parsed.question } : {}),
    ...(comment.kind ? { commentKind: comment.kind } : {}),
    ...(comment.authorAssociation
      ? { authorAssociation: comment.authorAssociation }
      : {}),
  };
}
