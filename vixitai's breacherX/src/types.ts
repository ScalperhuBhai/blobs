/**
 * Core domain types for the BreacherX review pipeline.
 *
 * These model the "Finding record" from the blueprint:
 *   rule_id, severity, confidence, file_path, start_line, end_line,
 *   problem, evidence[], impact, suggested_patch?, introduced_by_change,
 *   verification_status, analyzer_result, test_result, model_version
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/** Finding categories, aligned with the blueprint's specialist discovery passes. */
export type FindingCategory =
  | "correctness"
  | "security"
  | "reliability"
  | "performance"
  | "test-gap"
  | "style"
  | "maintainability";

/**
 * Verification status after the independent evidence check.
 * - verified:   evidence confirms the claim and it is introduced by this change
 * - plausible:  evidence is consistent but not conclusive
 * - unverified: could not corroborate; published only if confidence is very high
 * - rejected:   failed verification (out of range, pre-existing, or contradicted)
 */
export type VerificationStatus = "verified" | "plausible" | "unverified" | "rejected";

/** Where a finding originated. Deterministic sources carry more trust by default. */
export type FindingSource =
  | "builtin"
  | "ruff"
  | "eslint"
  | "semgrep"
  | "model"
  | "merged";

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "ruby"
  | "rust"
  | "unknown";

/** A single line inside a diff hunk. */
export interface DiffLine {
  kind: "add" | "del" | "context";
  content: string;
  /** 1-based line number in the new (head) file; undefined for deleted lines. */
  newLine?: number;
  /** 1-based line number in the old (base) file; undefined for added lines. */
  oldLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
}

export type FileChangeType = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
  oldPath: string;
  newPath: string;
  changeType: FileChangeType;
  language: SupportedLanguage;
  isBinary: boolean;
  hunks: DiffHunk[];
  /** Set of 1-based new-file line numbers that were added/changed by this diff. */
  changedNewLines: Set<number>;
}

export interface ParsedDiff {
  files: FileDiff[];
}

/** The raw problem a model or analyzer reports, before verification. */
export interface RawFinding {
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  /** Source-reported confidence (0..1). NOT proof — calibrated during verification. */
  confidence: number;
  filePath: string;
  startLine: number;
  endLine: number;
  problem: string;
  evidence: string[];
  impact: string;
  suggestedPatch?: string;
  source: FindingSource;
  modelVersion?: string;
}

/** A fully-processed finding carrying verification metadata. */
export interface Finding extends RawFinding {
  id: string;
  introducedByChange: boolean;
  verificationStatus: VerificationStatus;
  /** Calibrated confidence after verification (0..1). */
  calibratedConfidence: number;
  analyzerResult?: string;
  testResult?: string;
  /** Rank score used for ordering and truncation. */
  rankScore: number;
}

export interface ReviewContextFile {
  file: FileDiff;
  /** Full head-file content when available (for context + range validation). */
  headContent?: string;
  /** Changed hunks rendered for a model prompt. */
  changedSnippet: string;
}

export interface ReviewInput {
  /** Raw unified diff text (git diff / PR patch). */
  diffText: string;
  /** Optional working tree root, used to read full-file context. */
  repoPath?: string;
  /** Logical identifier for the review (PR number, commit sha, etc.). */
  reviewId?: string;
}

export interface StageTrace {
  stage: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface CostTrace {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost for the run. */
  usd: number;
}

export interface ReviewResult {
  reviewId: string;
  createdAt: string;
  summary: string;
  reviewStatus: "approved" | "changes_requested" | "commented";
  findings: Finding[];
  /** Findings that were produced but filtered out (kept for auditing). */
  suppressed: Finding[];
  trace: StageTrace[];
  cost: CostTrace;
  stats: {
    filesChanged: number;
    changedLines: number;
    rawFindings: number;
    publishedFindings: number;
  };
}

/** Input handed to a model provider's discovery pass. */
export interface DiscoveryRequest {
  file: FileDiff;
  changedSnippet: string;
  headContent?: string;
  /** Deterministic findings already known, so the model can corroborate/avoid dupes. */
  knownFindings: RawFinding[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DiscoveryResponse {
  findings: RawFinding[];
  usage: ModelUsage;
  modelVersion: string;
}
