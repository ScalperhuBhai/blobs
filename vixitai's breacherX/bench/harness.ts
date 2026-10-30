/**
 * Accuracy benchmark harness (blueprint Phase 0 — "benchmark before scaling").
 *
 * Runs the pipeline over a labeled dataset and computes precision / recall / F1,
 * localization, latency and cost. This is the quality gate: no model, prompt,
 * threshold or rule change should ship without a reproducible comparison here.
 *
 * Dataset format (bench/datasets/<set>/cases.json):
 *   { "version": "1", "cases": [
 *       { "id": "...", "diff": "<unified diff>", "repoPath": "optional",
 *         "expected": [ { "file": "x.ts", "line": 12, "lineTolerance": 2,
 *                         "category": "security", "ruleIdContains": "eval" } ] } ] }
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../src/config.js";
import type { Finding } from "../src/types.js";
import { runReview } from "../src/pipeline/pipeline.js";
import { log } from "../src/util/logger.js";

export interface ExpectedFinding {
  file: string;
  line: number;
  lineTolerance?: number;
  category?: string;
  ruleIdContains?: string;
}

export interface BenchCase {
  id: string;
  diff: string;
  repoPath?: string;
  expected: ExpectedFinding[];
}

export interface BenchDataset {
  version: string;
  cases: BenchCase[];
}

export interface CaseResult {
  id: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  exactLocalized: number;
  latencyMs: number;
  costUsd: number;
  missed: ExpectedFinding[];
  spurious: Array<{ ruleId: string; file: string; line: number }>;
}

export interface BenchReport {
  dataset: string;
  datasetVersion: string;
  provider: string;
  cases: CaseResult[];
  metrics: {
    precision: number;
    recall: number;
    f1: number;
    localization: number;
    totalTp: number;
    totalFp: number;
    totalFn: number;
    avgLatencyMs: number;
    totalCostUsd: number;
  };
}

function matches(f: Finding, e: ExpectedFinding): boolean {
  if (f.filePath !== e.file) return false;
  const tol = e.lineTolerance ?? 2;
  if (Math.abs(f.startLine - e.line) > tol) return false;
  if (e.category && f.category !== e.category) return false;
  if (e.ruleIdContains && !f.ruleId.toLowerCase().includes(e.ruleIdContains.toLowerCase())) return false;
  return true;
}

async function resolveDatasetPath(set: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled location: <root>/dist/bench/harness.js  → root is ../..
  const candidates = [
    resolve(here, "../..", "bench/datasets", set, "cases.json"),
    resolve(here, "datasets", set, "cases.json"),
    resolve(process.cwd(), "bench/datasets", set, "cases.json"),
  ];
  for (const c of candidates) {
    try {
      await readFile(c, "utf8");
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(`dataset '${set}' not found (looked in: ${candidates.join(", ")})`);
}

export async function runBenchmark(set: string, config: Config): Promise<BenchReport> {
  const path = await resolveDatasetPath(set);
  const dataset = JSON.parse(await readFile(path, "utf8")) as BenchDataset;
  log.info(`benchmark '${set}' v${dataset.version}: ${dataset.cases.length} cases`);

  const caseResults: CaseResult[] = [];
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;
  let totalExact = 0;
  let totalLatency = 0;
  let totalCost = 0;

  for (const c of dataset.cases) {
    const result = await runReview(
      { diffText: c.diff, repoPath: c.repoPath, reviewId: `bench-${c.id}` },
      config,
    );
    const latency = result.trace.reduce((s, t) => s + t.ms, 0);
    totalLatency += latency;
    totalCost += result.cost.usd;

    const matchedExpected = new Set<number>();
    const matchedFindings = new Set<string>();
    let exact = 0;

    for (let ei = 0; ei < c.expected.length; ei++) {
      const e = c.expected[ei]!;
      for (const f of result.findings) {
        if (matchedFindings.has(f.id)) continue;
        if (matches(f, e)) {
          matchedExpected.add(ei);
          matchedFindings.add(f.id);
          if (Math.abs(f.startLine - e.line) <= 1) exact++;
          break;
        }
      }
    }

    const tp = matchedExpected.size;
    const fn = c.expected.length - tp;
    const fp = result.findings.length - matchedFindings.size;

    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
    totalExact += exact;

    caseResults.push({
      id: c.id,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      exactLocalized: exact,
      latencyMs: latency,
      costUsd: result.cost.usd,
      missed: c.expected.filter((_, i) => !matchedExpected.has(i)),
      spurious: result.findings
        .filter((f) => !matchedFindings.has(f.id))
        .map((f) => ({ ruleId: f.ruleId, file: f.filePath, line: f.startLine })),
    });
  }

  const precision = totalTp + totalFp === 0 ? 1 : totalTp / (totalTp + totalFp);
  const recall = totalTp + totalFn === 0 ? 1 : totalTp / (totalTp + totalFn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const localization = totalTp === 0 ? 0 : totalExact / totalTp;

  return {
    dataset: set,
    datasetVersion: dataset.version,
    provider: config.modelProvider,
    cases: caseResults,
    metrics: {
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      localization: round(localization),
      totalTp,
      totalFp,
      totalFn,
      avgLatencyMs: dataset.cases.length ? Math.round(totalLatency / dataset.cases.length) : 0,
      totalCostUsd: Number(totalCost.toFixed(6)),
    },
  };
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

export function formatBenchReport(report: BenchReport): string {
  const m = report.metrics;
  const lines: string[] = [];
  lines.push(`Benchmark: ${report.dataset} (v${report.datasetVersion}) · provider=${report.provider}`);
  lines.push("─".repeat(64));
  for (const c of report.cases) {
    const flag = c.falseNegatives > 0 || c.falsePositives > 0 ? "⚠" : "✓";
    lines.push(
      `${flag} ${c.id.padEnd(28)} TP=${c.truePositives} FP=${c.falsePositives} FN=${c.falseNegatives} ` +
        `(${c.latencyMs}ms)`,
    );
    for (const miss of c.missed) {
      lines.push(`    missed: ${miss.file}:${miss.line} ${miss.ruleIdContains ?? miss.category ?? ""}`);
    }
  }
  lines.push("─".repeat(64));
  lines.push(
    `Precision ${pct(m.precision)}  Recall ${pct(m.recall)}  F1 ${pct(m.f1)}  Localization ${pct(m.localization)}`,
  );
  lines.push(
    `TP=${m.totalTp} FP=${m.totalFp} FN=${m.totalFn}  avg ${m.avgLatencyMs}ms  cost $${m.totalCostUsd.toFixed(4)}`,
  );
  return lines.join("\n");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
