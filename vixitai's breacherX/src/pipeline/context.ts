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
import { indexSymbols, changedSymbols as computeChangedSymbols } from "../context/symbols.js";
import { extractImports } from "../context/imports.js";

/**
 * Reconstruct an approximate head-file view from the diff when no working tree is
 * available, so symbol indexing still has something to parse. It uses added +
 * context lines positioned by their new-file line numbers.
 */
function reconstructFromDiff(file: ReviewContextFile["file"]): string {
  const byLine = new Map<number, string>();
  let max = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine && (line.kind === "add" || line.kind === "context")) {
        byLine.set(line.newLine, line.content);
        if (line.newLine > max) max = line.newLine;
      }
    }
  }
  const lines: string[] = [];
  for (let i = 1; i <= max; i++) lines.push(byLine.get(i) ?? "");
  return lines.join("\n");
}

export async function buildContext(
  diff: ParsedDiff,
  repoPath: string | undefined,
): Promise<ReviewContextFile[]> {
  const out: ReviewContextFile[] = [];
  for (const file of diff.files) {
    if (file.isBinary) continue;
    const headContent =
      file.changeType === "deleted" ? undefined : await readHeadFile(repoPath, file.newPath);
    const parseSource = headContent ?? reconstructFromDiff(file);
    const symbols = indexSymbols(parseSource, file.language);
    out.push({
      file,
      headContent,
      changedSnippet: renderChangedSnippet(file),
      symbols,
      changedSymbols: computeChangedSymbols(symbols, file.changedNewLines),
      imports: extractImports(parseSource, file.language),
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
