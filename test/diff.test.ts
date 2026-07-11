import { describe, expect, it } from "vitest";
import {
  buildSuggestionBlock,
  mapFindingToHunk,
  parseDiff,
  parsePatch,
} from "../src/github/diff.js";

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,6 @@
 line1
 line2
+added3
+added4
 line5
 line6
`;

describe("parseDiff", () => {
  it("parses per-file hunks with new-side line numbers", () => {
    const files = parseDiff(SAMPLE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");
    expect(files[0].hunks).toHaveLength(1);

    const hunk = files[0].hunks[0];
    expect(hunk.newStart).toBe(1);
    expect([...hunk.newLineSet].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...hunk.addedLineSet].sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("parses a bare single-file patch", () => {
    const patch = `@@ -1,4 +1,6 @@
 line1
 line2
+added3
+added4
 line5
 line6`;
    const fh = parsePatch("src/foo.ts", patch);
    expect(fh.path).toBe("src/foo.ts");
    expect([...fh.hunks[0].addedLineSet].sort((a, b) => a - b)).toEqual([3, 4]);
  });
});

describe("mapFindingToHunk", () => {
  const files = parseDiff(SAMPLE_DIFF);

  it("keeps a finding that lands on a changed line", () => {
    expect(mapFindingToHunk({ path: "src/foo.ts", line: 3, side: "RIGHT" }, files)).toEqual({
      line: 3,
      side: "RIGHT",
    });
  });

  it("relocates a near-miss finding to the nearest diff line", () => {
    // Line 8 is not in the diff; nearest commentable new-side line is 6 (dist 2).
    expect(mapFindingToHunk({ path: "src/foo.ts", line: 8, side: "RIGHT" }, files)).toEqual({
      line: 6,
      side: "RIGHT",
    });
  });

  it("drops a finding far outside any hunk", () => {
    expect(mapFindingToHunk({ path: "src/foo.ts", line: 200, side: "RIGHT" }, files)).toBeNull();
  });

  it("drops a finding for a file not in the diff", () => {
    expect(mapFindingToHunk({ path: "src/other.ts", line: 3, side: "RIGHT" }, files)).toBeNull();
  });

  it("produces a multi-line comment when endLine is set", () => {
    expect(
      mapFindingToHunk({ path: "src/foo.ts", line: 3, endLine: 5, side: "RIGHT" }, files),
    ).toEqual({ line: 5, side: "RIGHT", startLine: 3, startSide: "RIGHT" });
  });
});

describe("buildSuggestionBlock", () => {
  it("wraps code in a 3-backtick suggestion fence", () => {
    expect(buildSuggestionBlock("const x = 1;")).toBe("```suggestion\nconst x = 1;\n```");
  });

  it("uses a longer fence when the payload contains a triple backtick", () => {
    const block = buildSuggestionBlock("a\n```\nb");
    expect(block.startsWith("````suggestion\n")).toBe(true);
    expect(block.endsWith("\n````")).toBe(true);
  });

  it("trims a trailing newline in the payload", () => {
    expect(buildSuggestionBlock("foo\n")).toBe("```suggestion\nfoo\n```");
  });
});
