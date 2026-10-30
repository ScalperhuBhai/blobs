/**
 * A dependency-free unified-diff parser.
 *
 * Handles the git diff format:
 *   diff --git a/path b/path
 *   new file mode / deleted file mode / rename from / rename to
 *   --- a/path
 *   +++ b/path
 *   @@ -oldStart,oldCount +newStart,newCount @@ optional section header
 *   context / +added / -removed lines
 *
 * The parser tracks new-file and old-file line numbers so downstream stages can
 * (a) restrict findings to changed lines and (b) validate reported line ranges.
 */

import type {
  DiffHunk,
  DiffLine,
  FileChangeType,
  FileDiff,
  ParsedDiff,
} from "../types.js";
import { detectLanguage } from "./lang.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const lines = diffText.split(/\r?\n/);
  const files: FileDiff[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }

    // Parse the "diff --git a/x b/y" header.
    const headerMatch = line.match(/^diff --git (.+) (.+)$/);
    let oldPath = headerMatch ? stripPrefix(headerMatch[1] ?? "") : "";
    let newPath = headerMatch ? stripPrefix(headerMatch[2] ?? "") : "";
    let changeType: FileChangeType = "modified";
    let isBinary = false;
    i++;

    // Consume extended header lines until the first hunk or next file.
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.startsWith("@@") || l.startsWith("diff --git ")) break;

      if (l.startsWith("new file mode")) changeType = "added";
      else if (l.startsWith("deleted file mode")) changeType = "deleted";
      else if (l.startsWith("rename from ")) {
        changeType = "renamed";
        oldPath = stripPrefix(l.slice("rename from ".length));
      } else if (l.startsWith("rename to ")) {
        changeType = "renamed";
        newPath = stripPrefix(l.slice("rename to ".length));
      } else if (l.startsWith("--- ")) {
        const p = stripPrefix(l.slice(4).trim());
        if (p !== "/dev/null") oldPath = p;
      } else if (l.startsWith("+++ ")) {
        const p = stripPrefix(l.slice(4).trim());
        if (p !== "/dev/null") newPath = p;
      } else if (l.startsWith("Binary files") || l.startsWith("GIT binary patch")) {
        isBinary = true;
      }
      i++;
    }

    const hunks: DiffHunk[] = [];
    const changedNewLines = new Set<number>();

    while (i < lines.length && (lines[i] ?? "").startsWith("@@")) {
      const m = (lines[i] ?? "").match(HUNK_RE);
      i++;
      if (!m) continue;

      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const hunk: DiffHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        header: (m[5] ?? "").trim(),
        lines: [],
      };

      let oldLine = oldStart;
      let newLine = newStart;

      while (i < lines.length) {
        const raw = lines[i] ?? "";
        if (raw.startsWith("@@") || raw.startsWith("diff --git ")) break;
        // "\ No newline at end of file" markers carry no line content.
        if (raw.startsWith("\\")) {
          i++;
          continue;
        }

        const marker = raw[0];
        const content = raw.slice(1);
        let dl: DiffLine;
        if (marker === "+") {
          dl = { kind: "add", content, newLine };
          changedNewLines.add(newLine);
          newLine++;
        } else if (marker === "-") {
          dl = { kind: "del", content, oldLine };
          oldLine++;
        } else {
          // Context line (space prefix, or an empty diff line).
          dl = { kind: "context", content, oldLine, newLine };
          oldLine++;
          newLine++;
        }
        hunk.lines.push(dl);
        i++;
      }

      hunks.push(hunk);
    }

    files.push({
      oldPath,
      newPath: newPath || oldPath,
      changeType,
      language: detectLanguage(newPath || oldPath),
      isBinary,
      hunks,
      changedNewLines,
    });
  }

  return { files };
}

/** Render the added/context lines of a file as an annotated snippet for a model prompt. */
export function renderChangedSnippet(file: FileDiff, maxLines = 400): string {
  const out: string[] = [];
  out.push(`FILE: ${file.newPath} (${file.language}, ${file.changeType})`);
  for (const hunk of file.hunks) {
    out.push(hunk.header ? `@@ ${hunk.header}` : "@@");
    for (const line of hunk.lines) {
      const ln = line.newLine ?? line.oldLine ?? 0;
      const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      const num = String(ln).padStart(5, " ");
      out.push(`${num} ${sign}${line.content}`);
      if (out.length >= maxLines) {
        out.push("... (snippet truncated)");
        return out.join("\n");
      }
    }
  }
  return out.join("\n");
}

/** Count of distinct added/changed new-file lines across all files. */
export function countChangedLines(diff: ParsedDiff): number {
  let total = 0;
  for (const f of diff.files) total += f.changedNewLines.size;
  return total;
}
