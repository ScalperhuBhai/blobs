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

export async function runReview(input: ReviewInput, config: Config): Promise<ReviewResult> {
  const trace: StageTrace[] = [];
  const reviewId = input.reviewId ?? `review-${Date.now()}`;
  const provider: ModelProvider = createProvider(config);

  // Stage 02 — Ingest + parse.
  const diff = await timed("ingest", trace, async () => parseUnifiedDiff(input.diffText), (d) => ({
    files: d.files.length,
  }));
  const reviewableFiles = diff.files.filter((f) => !f.isBinary);
  const byPath = new Map<string, FileDiff>();
  for (const f of reviewableFiles) byPath.set(f.newPath, f);

  // Stage 03 — Context.
  const context = await timed("context", trace, () => buildContext(diff, input.repoPath), (c) => ({
    files: c.length,
  }));
  const headByPath = new Map<string, { file: FileDiff; headContent?: string }>();
  for (const c of context) headByPath.set(c.file.newPath, { file: c.file, headContent: c.headContent });

  // Stage 04 — Deterministic checks (builtin always; external when a repo is present).
  const deterministic = await timed(
    "deterministic",
    trace,
    async () => {
      const builtin = reviewableFiles.flatMap((f) => runBuiltinAnalyzer(f));
      const external = await runExternalAnalyzers(input.repoPath, reviewableFiles);
      return [...builtin, ...external];
    },
    (r) => ({ findings: r.length }),
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
        const res = await provider.discover({
          file: c.file,
          changedSnippet: c.changedSnippet,
          headContent: c.headContent,
          knownFindings: known,
        });
        inputTokens += res.usage.inputTokens;
        outputTokens += res.usage.outputTokens;
        all.push(...res.findings);
      }
      return all;
    },
    (r) => ({ findings: r.length, inputTokens, outputTokens }),
  );

  const rawAll = [...deterministic, ...discovery];

  // Stage 06 — Verification.
  const verified = await timed(
    "verification",
    trace,
    async () => verifyFindings(rawAll, headByPath, config),
    (r) => ({ published: r.published.length, suppressed: r.suppressed.length }),
  );

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
      changedLines: countChangedLines(diff),
      rawFindings: rawAll.length,
      publishedFindings: published.length,
    },
  };

  const summary = buildSummary(partial);
  return { ...partial, summary };
}
