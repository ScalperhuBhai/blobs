import type { SupportedLanguage } from "../types.js";

const EXT_MAP: Record<string, SupportedLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  java: "java",
  rb: "ruby",
  rs: "rust",
};

export function detectLanguage(path: string): SupportedLanguage {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "unknown";
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? "unknown";
}

export function isJsFamily(lang: SupportedLanguage): boolean {
  return lang === "typescript" || lang === "javascript";
}
