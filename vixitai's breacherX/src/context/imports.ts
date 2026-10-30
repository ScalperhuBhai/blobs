/**
 * Import / dependency extraction (Phase 2 — dependency hints).
 *
 * Pulls module dependencies out of a file so context retrieval and the
 * dependency graph can follow them. Regex-based and language-scoped; a building
 * block for the full call/import graph described in the blueprint.
 */

import type { SupportedLanguage } from "../types.js";
import { isJsFamily } from "../util/lang.js";

export interface ImportRef {
  module: string;
  /** true when it resolves within the repo (relative path), false for external. */
  local: boolean;
}

export function extractImports(content: string, language: SupportedLanguage): ImportRef[] {
  if (!content) return [];
  const found = new Map<string, ImportRef>();
  const add = (mod: string) => {
    const m = mod.trim();
    if (!m) return;
    if (!found.has(m)) found.set(m, { module: m, local: m.startsWith(".") || m.startsWith("/") });
  };

  if (isJsFamily(language)) {
    for (const m of content.matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) add(m[1] ?? "");
    for (const m of content.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1] ?? "");
    for (const m of content.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)) add(m[1] ?? "");
  } else if (language === "python") {
    for (const m of content.matchAll(/^\s*import\s+([A-Za-z0-9_.]+)/gm)) add(m[1] ?? "");
    for (const m of content.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm)) {
      const mod = m[1] ?? "";
      found.set(mod, { module: mod, local: mod.startsWith(".") });
    }
  } else if (language === "go") {
    for (const m of content.matchAll(/^\s*(?:import\s+)?["]([^"]+)["]/gm)) add(m[1] ?? "");
  }

  return [...found.values()];
}
