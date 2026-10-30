/**
 * Stage 03 — Repository context.
 *
 * Builds per-file review context: parses the diff (done upstream), reads head
 * file content where a working tree is available, and renders a changed-lines
 * snippet for the model. Also provides line-scope helpers used by verification.
 */

import type {
  FileDiff,
  ParsedDiff,
  RawFinding,
  ReviewContextFile,
} from "../types.js";
import { renderChangedSnippet } from "../util/diff.js";
import { readHeadFile } from "../util/git.js";

export async function buildContext(
  diff: ParsedDiff,
  repoPath: string | undefined,
): Promise<ReviewContextFile[]> {
  const out: ReviewContextFile[] = [];
  for (const file of diff.files) {
    if (file.isBinary) continue;
    const headContent =
      file.changeType === "deleted" ? undefined : await readHeadFile(repoPath, file.newPath);
    out.push({
      file,
      headContent,
      changedSnippet: renderChangedSnippet(file),
    });
  }
  return out;
}

/** Is any line in [start,end] part of what this diff changed? */
export function overlapsChangedLines(file: FileDiff, start: number, end: number): boolean {
  for (let ln = start; ln <= end; ln++) {
    if (file.changedNewLines.has(ln)) return true;
  }
  return false;
}

/** The last valid new-file line number we know about (for range sanity checks). */
export function maxKnownLine(file: FileDiff, headContent?: string): number {
  let max = 0;
  for (const ln of file.changedNewLines) if (ln > max) max = ln;
  if (headContent) {
    const lineCount = headContent.split("\n").length;
    if (lineCount > max) max = lineCount;
  }
  return max;
}

/**
 * Restrict a set of raw findings to those that touch changed lines.
 * Deterministic analyzers can report anywhere in a file; the blueprint requires
 * comments to land on changed lines (changed-lines-only mode).
 */
export function restrictToChangedLines(
  findings: RawFinding[],
  byPath: Map<string, FileDiff>,
): { kept: RawFinding[]; dropped: RawFinding[] } {
  const kept: RawFinding[] = [];
  const dropped: RawFinding[] = [];
  for (const f of findings) {
    const file = byPath.get(f.filePath);
    if (file && overlapsChangedLines(file, f.startLine, f.endLine)) kept.push(f);
    else dropped.push(f);
  }
  return { kept, dropped };
}
