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

  it("returns null for junk / unrecognized verbs", () => {
    expect(parseCommand("just a normal comment")).toBeNull();
    expect(parseCommand("@warren")).toBeNull();
    expect(parseCommand("@warren frobnicate")).toBeNull();
    expect(parseCommand("please @warren review")).toBeNull(); // mention not at line start
    expect(parseCommand("")).toBeNull();
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
});
