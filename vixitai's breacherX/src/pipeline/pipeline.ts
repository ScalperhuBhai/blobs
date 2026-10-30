/**
 * End-to-end review pipeline (blueprint stages 02–08).
 *
 *   ingest → context → deterministic checks → AI discovery → verification → publish
 *
 * Every stage is timed; model usage and estimated cost are recorded. The result
 * is a ReviewResult that a GitHub App / CLI / CI job can act on.
 */

import type { Config } from "../config.js";
import type {
  FileDiff,
  Finding,
  RawFinding,
  ReviewInput,
  ReviewResult,
  StageTrace,
} from "../types.js";
import { parseUnifiedDiff, countChangedLines } from "../util/diff.js";
import { log } from "../util/logger.js";
import { runBuiltinAnalyzer } from "../analyzers/builtin.js";
import { runExternalAnalyzers } from "../analyzers/external.js";
import { createProvider, estimateCost, type ModelProvider } from "../models/provider.js";
import { buildContext } from "./context.js";
import { verifyFindings } from "./verification.js";
import { buildSummary, decideReviewStatus } from "./publish.js";
import { buildRetriever } from "../context/retrieval.js";
import { enclosingSymbol, type CodeSymbol } from "../context/symbols.js";
import {
  loadRepoConfig,
  applyRepoConfig,
  filterIgnoredFiles,
  runCustomRules,
  applyRuleOverrides,
} from "../config/repo.js";
import { loadCalibration } from "../db/feedback.js";

async function timed<T>(
  stage: string,
  trace: StageTrace[],
  fn: () => Promise<T>,
  detail?: (r: T) => Record<string, unknown>,
): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - t0);
  trace.push({ stage, ms, detail: detail ? detail(result) : undefined });
  log.debug(`stage ${stage} done in ${ms}ms`);
  return result;
}

export async function runReview(input: ReviewInput, baseConfig: Config): Promise<ReviewResult> {
  const trace: StageTrace[] = [];
  const reviewId = input.reviewId ?? `review-${Date.now()}`;

  // Repo-scoped config / custom rules (.breacherx.json), merged over runtime config.
  const repoConfig = await loadRepoConfig(input.repoPath, input.configPath);
  const config = applyRepoConfig(baseConfig, repoConfig);
  const provider: ModelProvider = createProvider(config);

  // Stage 02 — Ingest + parse.
  const diff = await timed("ingest", trace, async () => parseUnifiedDiff(input.diffText), (d) => ({
    files: d.files.length,
  }));
  const reviewableFiles = filterIgnoredFiles(
    diff.files.filter((f) => !f.isBinary),
    repoConfig,
  );
  const byPath = new Map<string, FileDiff>();
  for (const f of reviewableFiles) byPath.set(f.newPath, f);

  // Stage 03 — Context.
  const context = await timed(
    "context",
    trace,
    () => buildContext({ files: reviewableFiles }, input.repoPath),
    (c) => ({ files: c.length }),
  );
  const headByPath = new Map<string, { file: FileDiff; headContent?: string }>();
  for (const c of context) headByPath.set(c.file.newPath, { file: c.file, headContent: c.headContent });

  // Stage 04 — Deterministic checks (builtin always; external when a repo is present).
  const deterministic = await timed(
    "deterministic",
    trace,
    async () => {
      const builtin = reviewableFiles.flatMap((f) => runBuiltinAnalyzer(f));
      const custom = reviewableFiles.flatMap((f) => runCustomRules(f, repoConfig));
      const external = await runExternalAnalyzers(input.repoPath, reviewableFiles);
      return [...builtin, ...custom, ...external];
    },
    (r) => ({ findings: r.length }),
  );

  // Build a cross-file lexical retriever for related-context lookups (Phase 2).
  const retriever = buildRetriever(
    context.map((c) => ({ filePath: c.file.newPath, content: c.headContent ?? c.changedSnippet })),
  );

  // Stage 05 — AI discovery (one pass per changed file).
  let inputTokens = 0;
  let outputTokens = 0;
  const discovery = await timed(
    "discovery",
    trace,
    async () => {
      const all: RawFinding[] = [];
      for (const c of context) {
        if (c.file.changeType === "deleted") continue;
        const known = deterministic.filter((d) => d.filePath === c.file.newPath);
        const related = retriever
          .retrieve(c.changedSnippet, 4)
          .filter((s) => s.chunk.filePath !== c.file.newPath)
          .slice(0, 3);
        // Run each specialist pass (correctness/security/reliability/performance/…).
        for (const pass of config.discoveryPasses) {
          const res = await provider.discover({
            file: c.file,
            changedSnippet: c.changedSnippet,
            headContent: c.headContent,
            knownFindings: known,
            changedSymbols: c.changedSymbols,
            imports: c.imports,
            relatedContext: related,
            pass,
          });
          inputTokens += res.usage.inputTokens;
          outputTokens += res.usage.outputTokens;
          all.push(...res.findings);
        }
      }
      return all;
    },
    (r) => ({ findings: r.length, inputTokens, outputTokens, passes: config.discoveryPasses.length }),
  );

  const rawAll = applyRuleOverrides([...deterministic, ...discovery], repoConfig);

  // Stage 06 — Verification (with calibration learned from feedback, if any).
  const calibration = await loadCalibration(config.dataDir);
  const verified = await timed(
    "verification",
    trace,
    async () => verifyFindings(rawAll, headByPath, config, calibration),
    (r) => ({ published: r.published.length, suppressed: r.suppressed.length }),
  );

  // Annotate findings with their enclosing symbol (Phase 2 code intelligence).
  const symbolsByPath = new Map<string, CodeSymbol[]>();
  for (const c of context) symbolsByPath.set(c.file.newPath, c.symbols);
  const annotate = (list: Finding[]): void => {
    for (const f of list) {
      const syms = symbolsByPath.get(f.filePath);
      if (!syms) continue;
      const s = enclosingSymbol(syms, f.startLine);
      if (s) f.symbol = `${s.kind} ${s.name}`;
    }
  };
  annotate(verified.published);
  annotate(verified.suppressed);

  // Stage 07 — Publish.
  const published: Finding[] = verified.published;
  const reviewStatus = decideReviewStatus(published);
  const cost = {
    provider: provider.name,
    model: provider.name === "mock" ? undefined : provider.modelVersion,
    inputTokens,
    outputTokens,
    usd: estimateCost(provider.modelVersion, inputTokens, outputTokens),
  };

  const partial: Omit<ReviewResult, "summary"> = {
    reviewId,
    createdAt: new Date().toISOString(),
    reviewStatus,
    findings: published,
    suppressed: verified.suppressed,
    trace,
    cost,
    stats: {
      filesChanged: reviewableFiles.length,
      changedLines: countChangedLines({ files: reviewableFiles }),
      rawFindings: rawAll.length,
      publishedFindings: published.length,
    },
  };

  const summary = buildSummary(partial);
  return { ...partial, summary };
}
