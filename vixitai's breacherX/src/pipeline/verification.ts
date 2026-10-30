/**
 * Stage 06 — Independent verification.
 *
 * The accuracy differentiator. Takes raw findings from deterministic analyzers
 * and the AI discovery pass and decides what is trustworthy enough to publish:
 *
 *  1. Range validation   — the reported lines must exist and fall on changed code.
 *  2. Introduced-by-change — pre-existing code is not flagged (changed-lines-only).
 *  3. Deduplication      — identical findings collapse; nearby same-category
 *                          findings from different sources CORROBORATE each other.
 *  4. Calibration        — model confidence is NOT proof. Uncorroborated model
 *                          claims are penalized; deterministic + corroborated
 *                          findings are trusted. Thresholds are severity-aware so
 *                          important low-frequency bugs are not suppressed.
 */

import type { Config } from "../config.js";
import type {
  FileDiff,
  Finding,
  RawFinding,
  Severity,
  VerificationStatus,
} from "../types.js";
import { SEVERITY_ORDER } from "../types.js";
import { clamp01 } from "../config.js";
import { maxKnownLine, overlapsChangedLines } from "./context.js";

const DETERMINISTIC_SOURCES = new Set(["builtin", "ruff", "eslint", "semgrep"]);

export interface VerificationOutput {
  published: Finding[];
  suppressed: Finding[];
}

interface HeadIndex {
  file: FileDiff;
  maxLine: number;
}

function rangeIsValid(f: RawFinding, idx: HeadIndex | undefined): boolean {
  if (f.startLine <= 0 || f.endLine < f.startLine) return false;
  if (idx && idx.maxLine > 0 && f.startLine > idx.maxLine) return false;
  return true;
}

/** Severity-aware publish threshold: critical/high get a discount so we keep rare bugs. */
function thresholdFor(severity: Severity, base: number): number {
  const discount: Record<Severity, number> = {
    critical: 0.2,
    high: 0.12,
    medium: 0.0,
    low: 0.05,
    info: 0.1,
  };
  return clamp01(base - discount[severity]);
}

function makeId(f: RawFinding, n: number): string {
  return `fnd_${f.ruleId.replace(/[^a-z0-9]+/gi, "-")}_${f.startLine}_${n}`;
}

/** Two findings corroborate if same file, overlapping/adjacent lines, same category. */
function corroborates(a: RawFinding, b: RawFinding): boolean {
  if (a.filePath !== b.filePath) return false;
  if (a.category !== b.category) return false;
  const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
  return gap <= 2;
}

export function verifyFindings(
  raw: RawFinding[],
  headByPath: Map<string, { file: FileDiff; headContent?: string }>,
  config: Config,
): VerificationOutput {
  const headIndex = new Map<string, HeadIndex>();
  for (const [path, v] of headByPath) {
    headIndex.set(path, { file: v.file, maxLine: maxKnownLine(v.file, v.headContent) });
  }

  // Exact-duplicate collapse (same ruleId + file + startLine): keep the most confident.
  const exactMap = new Map<string, RawFinding>();
  for (const f of raw) {
    const key = `${f.ruleId}|${f.filePath}|${f.startLine}`;
    const existing = exactMap.get(key);
    if (!existing || f.confidence > existing.confidence) exactMap.set(key, f);
  }
  const deduped = [...exactMap.values()];

  const published: Finding[] = [];
  const suppressed: Finding[] = [];
  let counter = 0;

  for (const f of deduped) {
    counter++;
    const idx = headIndex.get(f.filePath);
    const file = idx?.file;

    // 1. Range validation.
    if (!rangeIsValid(f, idx)) {
      suppressed.push(finalize(f, counter, false, "rejected", 0, "range-invalid"));
      continue;
    }

    // 2. Introduced-by-change.
    const introduced = file ? overlapsChangedLines(file, f.startLine, f.endLine) : true;
    if (config.changedLinesOnly && !introduced) {
      suppressed.push(finalize(f, counter, introduced, "rejected", 0, "pre-existing"));
      continue;
    }

    // 3. Corroboration against the *other* findings.
    const isDeterministic = DETERMINISTIC_SOURCES.has(f.source);
    let corroboratedByDeterministic = false;
    let corroboratedByModel = false;
    for (const other of deduped) {
      if (other === f) continue;
      if (!corroborates(f, other)) continue;
      if (DETERMINISTIC_SOURCES.has(other.source)) corroboratedByDeterministic = true;
      if (other.source === "model") corroboratedByModel = true;
    }

    // 4. Calibration + status.
    let status: VerificationStatus;
    let calibrated: number;
    let analyzerResult: string;

    if (isDeterministic) {
      // Deterministic tools are high-trust evidence.
      calibrated = clamp01(f.confidence * (corroboratedByModel ? 1.05 : 0.98));
      status = "verified";
      analyzerResult = `deterministic:${f.source}${corroboratedByModel ? "+model" : ""}`;
    } else if (corroboratedByDeterministic) {
      // Model claim backed by a deterministic tool → trust it.
      calibrated = clamp01(Math.max(f.confidence, 0.8));
      status = "verified";
      analyzerResult = "model+deterministic-corroboration";
    } else {
      // Uncorroborated model claim: confidence is not proof — penalize.
      calibrated = clamp01(f.confidence * 0.75);
      status = calibrated >= 0.5 ? "plausible" : "unverified";
      analyzerResult = "model-only";
    }

    const threshold = thresholdFor(f.severity, config.minConfidence);
    const extraForUnverified = status === "unverified" ? 0.2 : 0;
    const passes = calibrated >= threshold + extraForUnverified;

    const finding = finalize(f, counter, introduced, status, calibrated, analyzerResult);
    if (passes) published.push(finding);
    else suppressed.push(finding);
  }

  published.sort((a, b) => b.rankScore - a.rankScore);

  // Enforce max findings; demoted ones move to suppressed.
  if (published.length > config.maxFindings) {
    const overflow = published.splice(config.maxFindings);
    suppressed.push(...overflow);
  }

  return { published, suppressed };
}

function finalize(
  f: RawFinding,
  n: number,
  introduced: boolean,
  status: VerificationStatus,
  calibrated: number,
  analyzerResult: string,
): Finding {
  const sev = SEVERITY_ORDER[f.severity];
  const statusWeight =
    status === "verified" ? 1.0 : status === "plausible" ? 0.7 : status === "unverified" ? 0.4 : 0;
  const rankScore = sev * 10 + calibrated * 5 * statusWeight;
  return {
    ...f,
    id: makeId(f, n),
    introducedByChange: introduced,
    verificationStatus: status,
    calibratedConfidence: Number(calibrated.toFixed(3)),
    analyzerResult,
    rankScore: Number(rankScore.toFixed(3)),
  };
}
