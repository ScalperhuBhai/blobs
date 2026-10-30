/**
 * Stage 07 — Publish.
 *
 * Turns verified findings into a review verdict, a summary, ranked inline
 * comments, and machine-readable output (JSON / Markdown). This is what a
 * GitHub App would translate into a review with inline comments.
 */

import type { Finding, ReviewResult, Severity } from "../types.js";

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

export function decideReviewStatus(findings: Finding[]): ReviewResult["reviewStatus"] {
  const blocking = findings.some(
    (f) =>
      (f.severity === "critical" || f.severity === "high") &&
      f.verificationStatus !== "unverified",
  );
  if (blocking) return "changes_requested";
  return findings.length > 0 ? "commented" : "approved";
}

export function buildSummary(result: Omit<ReviewResult, "summary">): string {
  const bySeverity = new Map<Severity, number>();
  for (const f of result.findings) {
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  }
  const counts = (["critical", "high", "medium", "low", "info"] as Severity[])
    .filter((s) => bySeverity.get(s))
    .map((s) => `${SEVERITY_EMOJI[s]} ${bySeverity.get(s)} ${s}`)
    .join("  ·  ");

  const verdict =
    result.reviewStatus === "changes_requested"
      ? "Changes requested — blocking issues found."
      : result.reviewStatus === "commented"
        ? "Reviewed with comments."
        : "No blocking issues found in the changed lines.";

  return (
    `${verdict}\n\n` +
    `Scanned ${result.stats.filesChanged} file(s), ${result.stats.changedLines} changed line(s). ` +
    `Published ${result.stats.publishedFindings} of ${result.stats.rawFindings} candidate finding(s).` +
    (counts ? `\n\n${counts}` : "")
  );
}

export function renderMarkdown(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`# BreacherX review — ${result.reviewId}`);
  lines.push("");
  lines.push(`**Status:** ${result.reviewStatus}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  if (result.testRun?.ran) {
    lines.push(`**Tests:** ${result.testRun.passed ? "✅ passed" : "❌ failed"} via \`${result.testRun.command}\` (${result.testRun.durationMs}ms) — evidence, not proof.`);
    lines.push("");
  }

  if (result.findings.length === 0) {
    lines.push("_No findings published._");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const f of result.findings) {
      lines.push(
        `### ${SEVERITY_EMOJI[f.severity]} ${f.severity.toUpperCase()} · ${f.ruleId} ` +
          `\`${f.filePath}:${f.startLine}${f.endLine !== f.startLine ? `-${f.endLine}` : ""}\``,
      );
      lines.push("");
      if (f.symbol) lines.push(`- **Location:** in ${f.symbol}`);
      lines.push(`- **Problem:** ${f.problem}`);
      lines.push(`- **Impact:** ${f.impact}`);
      lines.push(
        `- **Confidence:** ${(f.calibratedConfidence * 100).toFixed(0)}% ` +
          `(${f.verificationStatus}, via ${f.analyzerResult ?? f.source})`,
      );
      if (f.testResult) lines.push(`- **Tests:** ${f.testResult} _(evidence, not proof)_`);
      if (f.evidence.length) {
        lines.push(`- **Evidence:**`);
        for (const e of f.evidence) lines.push(`  - \`${e}\``);
      }
      if (f.suggestedPatch) {
        lines.push(`- **Suggested patch:**`);
        lines.push("");
        lines.push("```diff");
        lines.push(f.suggestedPatch);
        lines.push("```");
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(
    `_Trace: ${result.trace.map((t) => `${t.stage} ${t.ms}ms`).join(", ")} · ` +
      `provider ${result.cost.provider}${result.cost.model ? ` (${result.cost.model})` : ""} · ` +
      `~$${result.cost.usd.toFixed(4)}_`,
  );
  return lines.join("\n");
}

export function renderText(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`BreacherX review ${result.reviewId} — ${result.reviewStatus.toUpperCase()}`);
  lines.push(result.summary.replace(/\n+/g, " "));
  lines.push("");
  for (const f of result.findings) {
    lines.push(
      `${SEVERITY_EMOJI[f.severity]} [${f.severity}] ${f.filePath}:${f.startLine} ${f.ruleId}`,
    );
    lines.push(`   ${f.problem} (${(f.calibratedConfidence * 100).toFixed(0)}%, ${f.verificationStatus})`);
  }
  if (result.findings.length === 0) lines.push("(no findings)");
  return lines.join("\n");
}
