# Roadmap

Mapped to the blueprint's six phases. ✅ = built in this repo, 🟡 = partially
scaffolded, ⏳ = specified/next.

## Phase 0 — Accuracy lab (built ✅)
- ✅ Benchmark harness with precision/recall/F1/localization/latency/cost.
- ✅ Versioned labeled regression dataset (`bench/datasets/regression`).
- ✅ Experiment inputs/outputs captured per run (`src/db/store.ts`,
  `eval_runs` table).
- ✅ Release-gate exit code (`bench --min-precision`).
- ⏳ Public benchmark adapter (e.g. ReviewBench) — verify repo/license/task
  format before adoption, then add as another dataset `--set`.

## Phase 1 — End-to-end MVP (built ✅)
- ✅ Diff parsing, context, deterministic checks, AI findings, verification,
  ranked publish, CLI.
- ✅ Pluggable model provider with Anthropic implementation + cost tracking.
- ✅ GitHub App control plane: signed webhook ingestion (`src/server`,
  `src/github`), base/head capture, idempotent job enqueue with retries + DLQ,
  diff fetch, inline-comment posting via the reviews API, dry-run/shadow mode.
- ⏳ Persistent control plane: auth, multi-tenant job lifecycle, provider policy,
  swap the in-memory queue for SQS + DLQ and the JSON store for Postgres.

## Phase 2 — Context engine (⏳ / 🟡)
- 🟡 Language detection + head-file context (done); hunk→symbol mapping is next.
- ⏳ tree-sitter AST + symbol index, incremental re-parse of changed files.
- ⏳ Dependency/call graph; recompute affected regions only.
- ⏳ Hybrid lexical + vector retrieval over `code_chunks` (pgvector).
- ⏳ Versioned, repo-scoped project rules (`REVIEW.md`/custom rules).

## Phase 3 — Verification hardening (core built ✅ / reproduction ⏳)
- ✅ Range validation, introduced-by-change, dedupe, corroboration, calibration.
- ⏳ Targeted test reproduction in a disposable isolated worker (base vs head),
  feeding `test_result` — with the caveats in `ACCURACY.md`/`SECURITY.md`.
- ⏳ Confidence calibration fit against the accumulated `finding_feedback` labels.

## Phase 4 — Shadow beta (⏳)
- ⏳ Review real PRs without posting; compare to human reviews, accepted fixes,
  and subsequent bugs.
- ⏳ Developer feedback labels wired to `finding_feedback`; auto-promote
  confirmed misses/false-positives into the regression suite.

## Phase 5 — Product breadth (⏳, after gates)
- ⏳ Safe autofix (human-approval gated), review chat, CLI/IDE integrations,
  billing, analytics, enterprise controls (SSO, audit export, data residency).
- ⏳ More languages, driven by measured demand and analyzer coverage.

## Decision (from the blueprint)

Build the evaluation lab and one secure GitHub review loop first. Scale model
spend only when experiments show the next component improves real defect
detection. Phases 0 and the Phase 1 core are done here; the GitHub App is the
next concrete milestone.
