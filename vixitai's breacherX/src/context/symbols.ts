/**
 * Structural symbol indexer (Phase 2 — code intelligence).
 *
 * A dependency-free approximation of what tree-sitter provides: it extracts
 * functions, classes and methods with their line ranges so the pipeline can map
 * a changed hunk to the enclosing symbol. That mapping drives better review
 * comments ("in function X"), better dedup (group by symbol), and richer model
 * context. It is intentionally lightweight — brace matching for C-family / JS /
 * TS and indentation for Python — and degrades to an empty index on anything it
 * cannot parse. tree-sitter can replace this behind the same `CodeSymbol` shape.
 */

import type { SupportedLanguage } from "../types.js";
import { isJsFamily } from "../util/lang.js";

export type SymbolKind = "function" | "class" | "method" | "interface" | "other";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  signature: string;
}

const JS_DECL: Array<{ kind: SymbolKind; re: RegExp; arrow?: boolean }> = [
  { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
  { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/ },
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(/ },
  { kind: "function", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/, arrow: true },
];

// Find the line of the matching close brace, starting from the first "{" at/after startIdx.
function findBraceEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  let inStr: string | null = null;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inStr) {
        if (ch === "\\") c++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      // Strip line comments cheaply.
      if (ch === "/" && line[c + 1] === "/") break;
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
        if (started && depth === 0) return i + 1; // 1-based
      }
    }
  }
  return lines.length;
}

function indexBraceLang(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const decl of JS_DECL) {
      const m = line.match(decl.re);
      if (m && m[1]) {
        // Expression-bodied arrow (no block) is a single logical line; don't
        // brace-match forward or it would swallow the rest of the file.
        const end = decl.arrow && !line.includes("{") ? i + 1 : findBraceEnd(lines, i);
        symbols.push({
          name: m[1],
          kind: decl.kind,
          startLine: i + 1,
          endLine: Math.max(i + 1, end),
          signature: line.trim().slice(0, 160),
        });
        break;
      }
    }
    // Class methods: a line like "name(args) {" inside a class body, not a keyword.
    const method = line.match(/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z0-9_$]+)\s*\([^;]*\)\s*(?::[^={]+)?\{/);
    if (method && method[1] && !/\b(if|for|while|switch|catch|return|function)\b/.test(method[1])) {
      const end = findBraceEnd(lines, i);
      symbols.push({
        name: method[1],
        kind: "method",
        startLine: i + 1,
        endLine: Math.max(i + 1, end),
        signature: line.trim().slice(0, 160),
      });
    }
  }
  return symbols;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function indexPython(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z0-9_]+)/);
    if (!m) continue;
    const indent = indentOf(m[1] ?? "");
    const kind: SymbolKind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    // Body ends at the next non-blank line with indent <= declaration indent.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l.trim() === "") continue;
      if (indentOf(l) <= indent) {
        end = j; // previous line was the last body line
        break;
      }
    }
    symbols.push({
      name: m[3] ?? "?",
      kind,
      startLine: i + 1,
      endLine: Math.max(i + 1, end),
      signature: line.trim().slice(0, 160),
    });
  }
  return symbols;
}

export function indexSymbols(content: string, language: SupportedLanguage): CodeSymbol[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  try {
    if (language === "python") return indexPython(lines);
    if (isJsFamily(language) || language === "go" || language === "java" || language === "rust") {
      return indexBraceLang(lines);
    }
  } catch {
    return [];
  }
  return [];
}

/** The most specific (smallest) symbol whose range contains the line, if any. */
export function enclosingSymbol(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const s of symbols) {
    if (line >= s.startLine && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
    }
  }
  return best;
}

/** Distinct symbols touched by a set of changed line numbers. */
export function changedSymbols(symbols: CodeSymbol[], changedLines: Iterable<number>): CodeSymbol[] {
  const hit = new Map<string, CodeSymbol>();
  for (const ln of changedLines) {
    const s = enclosingSymbol(symbols, ln);
    if (s) hit.set(`${s.name}:${s.startLine}`, s);
  }
  return [...hit.values()].sort((a, b) => a.startLine - b.startLine);
}
