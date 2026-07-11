/**
 * Unified-diff parsing helpers.
 *
 * Parses a PR `patch`/diff into per-file hunks carrying new-side (and old-side)
 * line numbers, and maps a Finding's (path, line, side) onto an actual diff hunk
 * so review comments are validated/relocated before we POST — GitHub returns 422
 * when a comment line is not part of the diff, so strays must be dropped or snapped
 * onto the nearest changed line.
 *
 * Also builds committable ```suggestion``` blocks with correct fence-counting.
 */

import type { DiffSide } from "../types.js";

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  /** New-side (RIGHT) line number; null for deleted lines. */
  newLine: number | null;
  /** Old-side (LEFT) line number; null for added lines. */
  oldLine: number | null;
  type: DiffLineType;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** New-side line numbers present in this hunk (added + context). */
  newLineSet: Set<number>;
  /** New-side line numbers that are ADDED (not context). */
  addedLineSet: Set<number>;
  /** Old-side line numbers present in this hunk (deleted + context). */
  oldLineSet: Set<number>;
}

export interface FileHunks {
  path: string;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a full unified diff (multiple files, with `diff --git` / `+++` headers)
 * into per-file hunks.
 */
export function parseDiff(diff: string): FileHunks[] {
  const files: FileHunks[] = [];
  let current: FileHunks | null = null;
  let hunk: DiffHunk | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      current = null;
      hunk = null;
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      const path = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      current = { path, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (!current) {
        // A bare patch (no +++ header): create an anonymous file bucket.
        current = { path: "", hunks: [] };
        files.push(current);
      }
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[3], 10);
      hunk = {
        oldStart: oldLine,
        oldLines: header[2] ? parseInt(header[2], 10) : 1,
        newStart: newLine,
        newLines: header[4] ? parseInt(header[4], 10) : 1,
        lines: [],
        newLineSet: new Set<number>(),
        addedLineSet: new Set<number>(),
        oldLineSet: new Set<number>(),
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // Skip truly-empty lines (e.g. a trailing newline). A blank *context* line in
    // a real diff is " " (a leading space), never "".
    if (raw === "" || raw.startsWith("\\")) continue; // "" / "\ No newline at end of file"

    const marker = raw[0];
    if (marker === "+") {
      hunk.lines.push({ newLine, oldLine: null, type: "add" });
      hunk.newLineSet.add(newLine);
      hunk.addedLineSet.add(newLine);
      newLine++;
    } else if (marker === "-") {
      hunk.lines.push({ newLine: null, oldLine, type: "del" });
      hunk.oldLineSet.add(oldLine);
      oldLine++;
    } else {
      // context line (leading space) or blank context line
      hunk.lines.push({ newLine, oldLine, type: "context" });
      hunk.newLineSet.add(newLine);
      hunk.oldLineSet.add(oldLine);
      newLine++;
      oldLine++;
    }
  }

  return files;
}

/**
 * Parse a single-file `patch` (as returned in `PrFile.patch`, which begins at the
 * first `@@` hunk with no file headers) into a FileHunks for `path`.
 */
export function parsePatch(path: string, patch: string): FileHunks {
  const parsed = parseDiff(`+++ b/${path}\n${patch}`);
  const fh = parsed[0];
  if (!fh) return { path, hunks: [] };
  return { path, hunks: fh.hunks };
}

export interface FindingLoc {
  path: string;
  line: number;
  endLine?: number;
  side?: DiffSide;
}

export interface MappedComment {
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
}

export interface MapOptions {
  /** Max distance (in lines) a stray comment may be relocated before being dropped. */
  window?: number;
}

const DEFAULT_RELOCATE_WINDOW = 5;

function snap(line: number, set: Set<number>, window: number): number | null {
  if (set.has(line)) return line;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const v of set) {
    const d = Math.abs(v - line);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  if (best !== null && bestDist <= window) return best;
  return null;
}

/**
 * Validate/relocate a finding onto the diff for its file.
 *
 * Returns the comment coordinates GitHub will accept (single- or multi-line), or
 * `null` if the finding cannot be placed on any hunk (drop it — otherwise the
 * batched review POST 422s).
 */
export function mapFindingToHunk(
  finding: FindingLoc,
  files: FileHunks[],
  opts: MapOptions = {},
): MappedComment | null {
  const fh = files.find((f) => f.path === finding.path);
  if (!fh || fh.hunks.length === 0) return null;

  const side: DiffSide = finding.side ?? "RIGHT";
  const window = opts.window ?? DEFAULT_RELOCATE_WINDOW;

  const set = new Set<number>();
  for (const h of fh.hunks) {
    const s = side === "LEFT" ? h.oldLineSet : h.newLineSet;
    for (const v of s) set.add(v);
  }
  if (set.size === 0) return null;

  const start = finding.line;
  const end =
    finding.endLine != null && finding.endLine >= finding.line ? finding.endLine : finding.line;

  const mappedEnd = snap(end, set, window);
  if (mappedEnd == null) return null;

  if (end === start) return { line: mappedEnd, side };

  const mappedStart = snap(start, set, window);
  if (mappedStart == null || mappedStart >= mappedEnd) {
    // Fall back to a single-line comment on the end line.
    return { line: mappedEnd, side };
  }
  return { line: mappedEnd, side, startLine: mappedStart, startSide: side };
}

/**
 * Build a committable ```suggestion``` block, counting existing backtick runs in
 * the payload and using a fence one longer than the longest run (min 3) so an
 * embedded code fence never terminates the block early.
 */
export function buildSuggestionBlock(suggestion: string): string {
  const runs = suggestion.match(/`+/g) ?? [];
  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fenceLen = Math.max(3, maxRun + 1);
  const fence = "`".repeat(fenceLen);
  const body = suggestion.replace(/\n+$/, "");
  return `${fence}suggestion\n${body}\n${fence}`;
}
