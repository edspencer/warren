import { describe, it, expect } from "vitest";
import type { IssueComment } from "../src/github/client.js";
import { parseCommand, parseWarrenCommand } from "../src/trigger/commands.js";

function comment(over: Partial<IssueComment> = {}): IssueComment {
  return {
    id: 1,
    body: "@warren review",
    author: "alice",
    createdAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

describe("parseCommand (body-level)", () => {
  const cases: Array<[string, string]> = [
    ["@warren review", "review"],
    ["@warren full review", "full_review"],
    ["@warren pause", "pause"],
    ["@warren resume", "resume"],
    ["@warren resolve", "resolve"],
    ["@warren help", "help"],
  ];
  for (const [body, kind] of cases) {
    it(`parses "${body}" -> ${kind}`, () => {
      expect(parseCommand(body)?.kind).toBe(kind);
    });
  }

  it("is case-insensitive and tolerates punctuation after the mention", () => {
    expect(parseCommand("@Warren: Review")?.kind).toBe("review");
    expect(parseCommand("@WARREN, pause")?.kind).toBe("pause");
  });

  it("matches on the first non-empty line, ignoring leading blank lines", () => {
    expect(parseCommand("\n\n  @warren full review  \nthanks!")?.kind).toBe("full_review");
  });

  it("prefers 'full review' over 'review' (longest match first)", () => {
    expect(parseCommand("@warren full review")?.kind).toBe("full_review");
  });

  it("matches an alternate bot login mention", () => {
    expect(parseCommand("@warren-bot resume", "warren-bot")?.kind).toBe("resume");
  });

  it("returns null for a bare mention, a non-mention, or a mid-line mention", () => {
    expect(parseCommand("just a normal comment")).toBeNull(); // no mention
    expect(parseCommand("@warren")).toBeNull(); // bare mention — not a command
    expect(parseCommand("@warren   ")).toBeNull(); // bare mention w/ trailing ws
    expect(parseCommand("please @warren review")).toBeNull(); // mention not at line start
    expect(parseCommand("")).toBeNull();
  });
});

describe("parseCommand — free-form ask (conversational Q&A)", () => {
  it("treats a mention + non-verb text as an ask, carrying the question", () => {
    const cmd = parseCommand("@warren why is this loop safe?");
    expect(cmd?.kind).toBe("ask");
    expect(cmd?.question).toBe("why is this loop safe?");
  });

  it("known verbs still win over ask (they are not free-form)", () => {
    expect(parseCommand("@warren review")?.kind).toBe("review");
    expect(parseCommand("@warren full review")?.kind).toBe("full_review");
    expect(parseCommand("@warren pause")?.kind).toBe("pause");
  });

  it("captures a multi-line question spanning lines after the mention", () => {
    const cmd = parseCommand("@warren can you explain\nthe retry logic here?");
    expect(cmd?.kind).toBe("ask");
    expect(cmd?.question).toBe("can you explain\nthe retry logic here?");
  });

  it("works with an alternate bot login", () => {
    const cmd = parseCommand("@warren-bot what does this regex match?", "warren-bot");
    expect(cmd?.kind).toBe("ask");
    expect(cmd?.question).toBe("what does this regex match?");
  });
});

describe("parseWarrenCommand (comment-level seam)", () => {
  it("carries the comment id and author through", () => {
    const cmd = parseWarrenCommand(comment({ id: 77, author: "bob", body: "@warren review" }));
    expect(cmd).toEqual({ kind: "review", raw: "@warren review", commentId: 77, author: "bob" });
  });

  it("ignores comments authored by the bot itself", () => {
    const self = comment({ author: "warren-bot", body: "@warren help\nAvailable commands: ..." });
    expect(parseWarrenCommand(self, "warren-bot")).toBeNull();
  });

  it("still parses non-bot commands when a botLogin is supplied", () => {
    const other = comment({ author: "carol", body: "@warren pause" });
    expect(parseWarrenCommand(other, "warren-bot")?.kind).toBe("pause");
  });

  it("returns null for non-command comments", () => {
    expect(parseWarrenCommand(comment({ body: "lgtm 👍" }))).toBeNull();
  });

  it("carries the question + comment channel through for an ask", () => {
    const cmd = parseWarrenCommand(
      comment({ id: 9, author: "dana", body: "@warren does this handle nulls?", kind: "review" }),
    );
    expect(cmd).toEqual({
      kind: "ask",
      raw: "@warren does this handle nulls?",
      commentId: 9,
      author: "dana",
      question: "does this handle nulls?",
      commentKind: "review",
    });
  });

  it("still ignores the bot's own ask-shaped comments", () => {
    const self = comment({ author: "warren-bot", body: "@warren here is the answer you asked for" });
    expect(parseWarrenCommand(self, "warren-bot")).toBeNull();
  });
});
