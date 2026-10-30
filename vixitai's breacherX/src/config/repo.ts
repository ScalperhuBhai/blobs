/**
 * Repo-scoped configuration and custom rules (`.breacherx.json`).
 *
 * Lets a repository tune the reviewer without code changes: thresholds, ignored
 * paths, disabled rules, severity overrides, and custom regex rules. This is the
 * blueprint's "versioned, repo-scoped project rules" + "custom rules".
 *
 * Repo config is scoped data, not trusted instructions: custom patterns are
 * length-capped and compiled defensively, ignored paths only *remove* review
 * scope, and disabled rules cannot be used to hide a finding's evidence trail
 * (suppressed findings are retained for audit).
 */

import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { Config } from "../config.js";
import type {
  FileDiff,
  FindingCategory,
  RawFinding,
  Severity,
  SupportedLanguage,
} from "../types.js";
import { log } from "../util/logger.js";

export interface CustomRule {
  id: string;
  pattern: string;
  languages?: SupportedLanguage[] | "any";
  severity?: Severity;
  category?: FindingCategory;
  message: string;
  impact?: string;
  confidence?: number;
}

export interface RepoConfig {
  minConfidence?: number;
  maxFindings?: number;
  changedLinesOnly?: boolean;
  ignorePaths?: string[];
  disabledRules?: string[];
  severityOverrides?: Record<string, Severity>;
  customRules?: CustomRule[];
}

const CONFIG_FILENAMES = [".breacherx.json", ".breacherx/config.json"];
const MAX_PATTERN_LEN = 200;

export async function loadRepoConfig(
  repoPath: string | undefined,
  explicitPath?: string,
): Promise<RepoConfig | undefined> {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  if (repoPath) for (const name of CONFIG_FILENAMES) candidates.push(join(repoPath, name));

  for (const path of candidates) {
    try {
      const raw = await readFile(isAbsolute(path) ? path : path, "utf8");
      const parsed = JSON.parse(raw) as RepoConfig;
      log.info(`loaded repo config from ${path}`);
      return sanitize(parsed);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function sanitize(cfg: RepoConfig): RepoConfig {
  const out: RepoConfig = {};
  if (typeof cfg.minConfidence === "number") out.minConfidence = clamp01(cfg.minConfidence);
  if (typeof cfg.maxFindings === "number") out.maxFindings = Math.max(1, Math.trunc(cfg.maxFindings));
  if (typeof cfg.changedLinesOnly === "boolean") out.changedLinesOnly = cfg.changedLinesOnly;
  if (Array.isArray(cfg.ignorePaths)) out.ignorePaths = cfg.ignorePaths.filter((s) => typeof s === "string");
  if (Array.isArray(cfg.disabledRules)) out.disabledRules = cfg.disabledRules.filter((s) => typeof s === "string");
  if (cfg.severityOverrides && typeof cfg.severityOverrides === "object") {
    out.severityOverrides = {};
    for (const [k, v] of Object.entries(cfg.severityOverrides)) {
      if (isSeverity(v)) out.severityOverrides[k] = v;
    }
  }
  if (Array.isArray(cfg.customRules)) {
    out.customRules = cfg.customRules
      .filter((r) => r && typeof r.id === "string" && typeof r.pattern === "string" && typeof r.message === "string")
      .filter((r) => r.pattern.length <= MAX_PATTERN_LEN)
      .slice(0, 100);
  }
  return out;
}

/** Merge repo config over the base runtime config. */
export function applyRepoConfig(base: Config, repo: RepoConfig | undefined): Config {
  if (!repo) return base;
  return {
    ...base,
    minConfidence: repo.minConfidence ?? base.minConfidence,
    maxFindings: repo.maxFindings ?? base.maxFindings,
    changedLinesOnly: repo.changedLinesOnly ?? base.changedLinesOnly,
  };
}

/** Tiny glob matcher: supports **, *, and literal segments (no braces/char classes). */
export function matchGlob(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(path);
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators (and an optional trailing /)
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function isIgnored(path: string, ignorePaths: string[] | undefined): boolean {
  if (!ignorePaths || ignorePaths.length === 0) return false;
  return ignorePaths.some((p) => matchGlob(path, p));
}

/** Drop diff files whose path matches an ignore glob. */
export function filterIgnoredFiles(files: FileDiff[], repo: RepoConfig | undefined): FileDiff[] {
  if (!repo?.ignorePaths?.length) return files;
  return files.filter((f) => !isIgnored(f.newPath, repo.ignorePaths));
}

/** Run a repo's custom regex rules against the added lines of a file. */
export function runCustomRules(file: FileDiff, repo: RepoConfig | undefined): RawFinding[] {
  const rules = repo?.customRules;
  if (!rules || rules.length === 0 || file.isBinary || file.changeType === "deleted") return [];
  const compiled = rules
    .map((r) => {
      try {
        return { rule: r, re: new RegExp(r.pattern) };
      } catch {
        log.warn(`invalid custom rule pattern '${r.id}': ${r.pattern}`);
        return undefined;
      }
    })
    .filter((x): x is { rule: CustomRule; re: RegExp } => x !== undefined);

  const findings: RawFinding[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "add") continue;
      const lineNo = line.newLine ?? 0;
      for (const { rule, re } of compiled) {
        if (rule.languages && rule.languages !== "any" && !rule.languages.includes(file.language)) continue;
        if (!re.test(line.content)) continue;
        findings.push({
          ruleId: rule.id.startsWith("repo/") ? rule.id : `repo/${rule.id}`,
          category: rule.category ?? "maintainability",
          severity: rule.severity ?? "medium",
          confidence: clamp01(rule.confidence ?? 0.8),
          filePath: file.newPath,
          startLine: lineNo,
          endLine: lineNo,
          problem: rule.message,
          evidence: [`${file.newPath}:${lineNo}  ${line.content.trim()}`],
          impact: rule.impact ?? "Flagged by a repository custom rule.",
          source: "builtin",
        });
      }
    }
  }
  return findings;
}

/** Apply disabledRules + severityOverrides to a raw finding set. */
export function applyRuleOverrides(findings: RawFinding[], repo: RepoConfig | undefined): RawFinding[] {
  if (!repo) return findings;
  const disabled = repo.disabledRules ?? [];
  const overrides = repo.severityOverrides ?? {};
  const isDisabled = (ruleId: string) => disabled.some((d) => ruleId === d || ruleId.startsWith(d));
  return findings
    .filter((f) => !isDisabled(f.ruleId))
    .map((f) => (overrides[f.ruleId] ? { ...f, severity: overrides[f.ruleId]! } : f));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function isSeverity(v: unknown): v is Severity {
  return v === "critical" || v === "high" || v === "medium" || v === "low" || v === "info";
}
