/**
 * Built-in deterministic analyzer.
 *
 * Pure-regex, dependency-free rules scoped to the lines a diff actually changed.
 * These exist so BreacherX produces useful, corroborating signal even when no
 * external tool (ruff/eslint/semgrep) is installed. Deterministic findings are
 * treated as high-trust evidence the AI pass can corroborate against.
 */

import type {
  DiffLine,
  FileDiff,
  FindingCategory,
  RawFinding,
  Severity,
  SupportedLanguage,
} from "../types.js";

interface Rule {
  id: string;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  languages: "any" | SupportedLanguage[];
  pattern: RegExp;
  problem: string;
  impact: string;
  /** Optional guard to suppress obvious false positives. */
  ignoreIf?: RegExp;
}

const RULES: Rule[] = [
  // --- Secrets (language-agnostic) ------------------------------------------
  {
    id: "secret/aws-access-key",
    category: "security",
    severity: "critical",
    confidence: 0.9,
    languages: "any",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    problem: "Hardcoded AWS access key id committed to source.",
    impact: "Leaked credentials allow account takeover; rotate immediately.",
  },
  {
    id: "secret/private-key",
    category: "security",
    severity: "critical",
    confidence: 0.9,
    languages: "any",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    problem: "Private key material embedded in the diff.",
    impact: "Private keys must never be committed; they grant signing/decrypt access.",
  },
  {
    id: "secret/generic-assignment",
    category: "security",
    severity: "high",
    confidence: 0.6,
    languages: "any",
    pattern:
      /\b(?:api[_-]?key|secret|passwd|password|token|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    problem: "Possible hardcoded secret assigned to a credential-like identifier.",
    impact: "Secrets in source leak through history, logs, and backups.",
    ignoreIf: /(process\.env|os\.environ|getenv|example|dummy|placeholder|xxx|\$\{)/i,
  },

  // --- JS/TS correctness & security -----------------------------------------
  {
    id: "js/eval-use",
    category: "security",
    severity: "high",
    confidence: 0.75,
    languages: ["javascript", "typescript"],
    pattern: /\beval\s*\(/,
    problem: "Use of eval() on possibly untrusted input.",
    impact: "eval enables arbitrary code execution and is rarely necessary.",
  },
  {
    id: "js/loose-equality-null",
    category: "correctness",
    severity: "low",
    confidence: 0.55,
    languages: ["javascript", "typescript"],
    pattern: /[^=!]==\s*(null|undefined)\b|[^=!]!=\s*(null|undefined)\b/,
    problem: "Loose (==/!=) comparison with null/undefined.",
    impact: "Coercion can mask bugs; prefer === / !== or an explicit nullish check.",
    ignoreIf: /===|!==/,
  },
  {
    id: "js/child-process-exec",
    category: "security",
    severity: "high",
    confidence: 0.7,
    languages: ["javascript", "typescript"],
    pattern: /child_process\.exec\s*\(|\bexec\s*\(\s*[`'"].*\$\{/,
    problem: "Shell command built with interpolation passed to exec().",
    impact: "String-built shell commands invite command injection; prefer execFile with args.",
  },
  {
    id: "js/leftover-debug",
    category: "maintainability",
    severity: "info",
    confidence: 0.5,
    languages: ["javascript", "typescript"],
    pattern: /console\.(log|debug)\s*\(/,
    problem: "Leftover console.log/debug statement.",
    impact: "Debug logging pollutes output and can leak data; remove before merge.",
  },
  {
    id: "js/non-null-assertion",
    category: "reliability",
    severity: "low",
    confidence: 0.5,
    languages: ["typescript"],
    pattern: /\w!\.\w|\w!\[/,
    problem: "Non-null assertion (!) bypasses the type checker.",
    impact: "If the value is actually null/undefined this throws at runtime.",
  },

  // --- Python correctness & security ----------------------------------------
  {
    id: "py/eval-exec",
    category: "security",
    severity: "high",
    confidence: 0.75,
    languages: ["python"],
    pattern: /\b(?:eval|exec)\s*\(/,
    problem: "Use of eval()/exec() in Python.",
    impact: "Dynamic execution of strings is a common RCE vector.",
  },
  {
    id: "py/subprocess-shell-true",
    category: "security",
    severity: "high",
    confidence: 0.75,
    languages: ["python"],
    pattern: /subprocess\.\w+\([^)]*shell\s*=\s*True/,
    problem: "subprocess call with shell=True.",
    impact: "shell=True with interpolated input enables command injection.",
  },
  {
    id: "py/bare-except",
    category: "reliability",
    severity: "medium",
    confidence: 0.65,
    languages: ["python"],
    pattern: /^\s*except\s*:/,
    problem: "Bare 'except:' swallows all exceptions including KeyboardInterrupt.",
    impact: "Hides real errors and makes the process hard to interrupt; catch specific types.",
  },
  {
    id: "py/mutable-default-arg",
    category: "correctness",
    severity: "medium",
    confidence: 0.7,
    languages: ["python"],
    pattern: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/,
    problem: "Mutable default argument ([] or {}).",
    impact: "The default is shared across calls, a classic source of state-leak bugs.",
  },
  {
    id: "py/assert-for-validation",
    category: "security",
    severity: "low",
    confidence: 0.5,
    languages: ["python"],
    pattern: /^\s*assert\s+/,
    problem: "assert used for runtime validation.",
    impact: "asserts are stripped under python -O; use explicit checks for security-relevant guards.",
  },

  // --- SQL injection (language-agnostic heuristic) --------------------------
  {
    id: "sql/string-built-query",
    category: "security",
    severity: "high",
    confidence: 0.6,
    languages: "any",
    pattern:
      /(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*(?:\+\s*\w+|\$\{|%\s*\(|%\s*\w+|f["'])/i,
    problem: "SQL query appears to be built via string concatenation/interpolation.",
    impact: "Interpolated SQL enables injection; use parameterized queries.",
    ignoreIf: /\?|:\w+|%s|execute\(/,
  },
];

function ruleAppliesToLang(rule: Rule, lang: SupportedLanguage): boolean {
  if (rule.languages === "any") return true;
  return rule.languages.includes(lang);
}

/**
 * Run built-in rules against the added lines of a file diff.
 * Only added lines are inspected so we do not flag pre-existing code.
 */
export function runBuiltinAnalyzer(file: FileDiff): RawFinding[] {
  if (file.isBinary || file.changeType === "deleted") return [];
  const findings: RawFinding[] = [];
  const seen = new Set<string>();

  const addedLines: DiffLine[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") addedLines.push(line);
    }
  }

  for (const line of addedLines) {
    const text = line.content;
    const lineNo = line.newLine ?? 0;
    for (const rule of RULES) {
      if (!ruleAppliesToLang(rule, file.language)) continue;
      if (!rule.pattern.test(text)) continue;
      if (rule.ignoreIf && rule.ignoreIf.test(text)) continue;

      const dedupeKey = `${rule.id}:${file.newPath}:${lineNo}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        confidence: rule.confidence,
        filePath: file.newPath,
        startLine: lineNo,
        endLine: lineNo,
        problem: rule.problem,
        evidence: [`${file.newPath}:${lineNo}  ${text.trim()}`],
        impact: rule.impact,
        source: "builtin",
      });
    }
  }

  return findings;
}

/** Exposed for documentation / tests. */
export function builtinRuleCount(): number {
  return RULES.length;
}
