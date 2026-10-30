/**
 * Offline heuristic "model" provider.
 *
 * This is NOT a real LLM. It is a deterministic stand-in so the full pipeline —
 * discovery, verification, ranking, publishing, benchmarking — runs end-to-end
 * with no API key and no network. It emits candidate findings from a second set
 * of semantic-ish heuristics (distinct from the builtin analyzer) with modest,
 * deliberately imperfect confidence, so the verification stage has real work to
 * do (dedup, range checks, calibration). Swap in AnthropicProvider for real runs.
 */

import type {
  DiffLine,
  DiscoveryRequest,
  DiscoveryResponse,
  FindingCategory,
  RawFinding,
  Severity,
} from "../types.js";
import { isJsFamily } from "../util/lang.js";

interface HeuristicRule {
  id: string;
  category: FindingCategory;
  severity: Severity;
  confidence: number;
  test: (line: string, lang: string) => boolean;
  problem: string;
  impact: string;
  suggest?: (line: string) => string | undefined;
}

const HEURISTICS: HeuristicRule[] = [
  {
    id: "model/unawaited-promise",
    category: "reliability",
    severity: "medium",
    confidence: 0.58,
    test: (l, lang) =>
      isJsFamily(lang as never) &&
      /\b(?:fetch|axios|\w+\.(?:save|update|delete|create|find)\w*)\s*\(/.test(l) &&
      !/\bawait\b|\.then\(|return |=>/.test(l) &&
      /;\s*$/.test(l),
    problem: "Async call result is neither awaited nor returned; the promise may float.",
    impact: "Floating promises drop errors and create race conditions / unhandled rejections.",
  },
  {
    id: "model/missing-error-handling",
    category: "reliability",
    severity: "low",
    confidence: 0.5,
    test: (l, lang) => isJsFamily(lang as never) && /JSON\.parse\s*\(/.test(l) && !/try/.test(l),
    problem: "JSON.parse without surrounding error handling.",
    impact: "Malformed input throws a SyntaxError that can crash the request handler.",
  },
  {
    id: "model/index-off-by-one",
    category: "correctness",
    severity: "medium",
    confidence: 0.52,
    test: (l) => /<=\s*\w+\.length\b/.test(l),
    problem: "Loop bound uses '<= length', which reads one past the end of the array.",
    impact: "Off-by-one access yields undefined / IndexError at the last iteration.",
  },
  {
    id: "model/unsafe-format-string",
    category: "security",
    severity: "medium",
    confidence: 0.54,
    test: (l, lang) => lang === "python" && /\.format\(|%\s*\(/.test(l) && /(SELECT|INSERT|UPDATE|DELETE)/i.test(l),
    problem: "SQL assembled with .format()/% interpolation.",
    impact: "User-controlled values in the query string enable SQL injection.",
  },
  {
    id: "model/todo-security",
    category: "security",
    severity: "low",
    confidence: 0.5,
    test: (l) => /\b(?:TODO|FIXME|HACK)\b.*(auth|secur|valid|sanitiz|escap)/i.test(l),
    problem: "Security-relevant TODO/FIXME left in changed code.",
    impact: "Unfinished security handling is a common source of real vulnerabilities.",
  },
  {
    id: "model/broad-permission",
    category: "security",
    severity: "high",
    confidence: 0.56,
    test: (l) => /chmod\s+0?777|S_IRWXO|permissions?\s*[:=]\s*['"]?0?777/.test(l),
    problem: "World-writable / 0777 permissions granted.",
    impact: "Overly broad permissions let any local user modify the resource.",
  },
];

/** Maps a specialist pass name to the finding categories it is responsible for. */
const PASS_CATEGORIES: Record<string, FindingCategory[]> = {
  correctness: ["correctness"],
  security: ["security"],
  reliability: ["reliability"],
  performance: ["performance"],
  "test-gap": ["test-gap"],
  maintainability: ["maintainability", "style"],
};

/** A cheap deterministic token estimate (~4 chars/token). */
function estTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockProvider {
  readonly name = "mock";
  readonly modelVersion = "mock-heuristic-v1";

  async discover(req: DiscoveryRequest): Promise<DiscoveryResponse> {
    const { file } = req;
    const findings: RawFinding[] = [];
    const seen = new Set<string>();

    // When run as a specialist pass, only emit findings of that pass's category.
    const allowed = req.pass ? PASS_CATEGORIES[req.pass] : undefined;

    const addedLines: DiffLine[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) if (line.kind === "add") addedLines.push(line);
    }

    for (const line of addedLines) {
      const lineNo = line.newLine ?? 0;
      for (const rule of HEURISTICS) {
        if (allowed && !allowed.includes(rule.category)) continue;
        if (!rule.test(line.content, file.language)) continue;
        const key = `${rule.id}:${file.newPath}:${lineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          confidence: rule.confidence,
          filePath: file.newPath,
          startLine: lineNo,
          endLine: lineNo,
          problem: rule.problem,
          evidence: [`${file.newPath}:${lineNo}  ${line.content.trim()}`],
          impact: rule.impact,
          suggestedPatch: rule.suggest?.(line.content),
          source: "model",
          modelVersion: this.modelVersion,
        });
      }
    }

    const inputTokens = estTokens(req.changedSnippet) + estTokens(req.headContent ?? "");
    const outputTokens = estTokens(JSON.stringify(findings));
    return {
      findings,
      usage: { inputTokens, outputTokens },
      modelVersion: this.modelVersion,
    };
  }
}
