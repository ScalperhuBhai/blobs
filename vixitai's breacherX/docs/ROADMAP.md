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

## Phase 2 — Context engine (core built ✅ / graph+vectors ⏳)
- ✅ Structural symbol index (functions/classes/methods) with line ranges —
  `src/context/symbols.ts` (brace matching for C-family/JS/TS, indentation for
  Python). tree-sitter can replace it behind the same `CodeSymbol` shape.
- ✅ Hunk→symbol mapping; findings annotated with their enclosing symbol.
- ✅ Import/dependency extraction — `src/context/imports.ts`.
- ✅ Lexical retrieval (BM25) behind a `Retriever` interface, wired into the AI
  discovery prompt — `src/context/retrieval.ts`.
- ✅ Repo-scoped config + custom rules (`.breacherx.json`): thresholds, ignored
  paths, disabled rules, severity overrides, custom regex rules — `src/config/repo.ts`.
- ⏳ Vector half of hybrid retrieval over `code_chunks` (pgvector) + full
  call/dependency graph and incremental indexing.

## Phase 3 — Verification hardening (built ✅ / reproduction ⏳)
- ✅ Range validation, introduced-by-change, dedupe, corroboration, severity-aware gating.
- ✅ Specialist multi-pass discovery (correctness/security/reliability/performance),
  configurable via `BREACHERX_DISCOVERY_PASSES`.
- ✅ Confidence calibration fit from developer feedback labels (`breacherx
  feedback` + `breacherx calibrate`), blended into verification — `src/pipeline/calibration.ts`,
  `src/db/feedback.ts`.
- ✅ Test reproduction (opt-in, no-shell, timeout-bounded) feeding `test_result`
  — `src/pipeline/reproduction.ts`. ⏳ remaining: base-vs-head differential runs
  inside a disposable isolated worker (see `SECURITY.md`).

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
