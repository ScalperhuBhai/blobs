# Architecture — blueprint stages mapped to code

BreacherX implements the blueprint's end-to-end flow as a sequence of timed
pipeline stages. Each stage is a small, testable module; the orchestrator
(`src/pipeline/pipeline.ts`) wires them together and records a trace.

```
ReviewInput (diff text, repoPath?, reviewId?)
        │
        ▼
 ┌──────────────┐   02 Ingest        parse unified diff → ParsedDiff
 │  ingest      │   src/util/diff.ts  (hunks, new/old line numbers, changed-line set)
 └──────┬───────┘
        ▼
 ┌──────────────┐   03 Context       read head files, render changed snippets
 │  context     │   src/pipeline/context.ts
 └──────┬───────┘
        ▼
 ┌──────────────┐   04 Deterministic builtin rules + ruff/eslint/semgrep adapters
 │ deterministic│   src/analyzers/{builtin,external}.ts
 └──────┬───────┘
        ▼
 ┌──────────────┐   05 AI discovery  one pass per changed file, pluggable provider
 │  discovery   │   src/models/{provider,mock,anthropic}.ts
 └──────┬───────┘
        ▼
 ┌──────────────┐   06 Verification  range check, introduced-by-change, dedupe,
 │ verification │   src/pipeline/verification.ts   corroboration, calibration
 └──────┬───────┘
        ▼
 ┌──────────────┐   07 Publish       verdict + summary + ranked findings (md/json/text)
 │  publish     │   src/pipeline/publish.ts
 └──────┬───────┘
        ▼
 ┌──────────────┐   08 Learn+measure run store (JSON) / benchmark harness
 │  persist     │   src/db/store.ts · bench/harness.ts
 └──────────────┘
```

## Module map

| Blueprint stage | Module | Notes |
|---|---|---|
| 02 Ingestion | `src/util/diff.ts` | Dependency-free unified-diff parser; tracks new/old line numbers and the changed-line set per file. |
| 03 Repository context | `src/pipeline/context.ts`, `src/context/*`, `src/util/git.ts`, `src/util/lang.ts` | Reads head-file content (or reconstructs from the diff), indexes symbols, maps hunks→symbols, extracts imports, and builds a BM25 retriever for related-context lookups. Full call/dependency graph + pgvector are Phase 2's remaining items. |
| 04 Deterministic checks | `src/analyzers/builtin.ts`, `src/analyzers/external.ts` | Builtin rule engine always runs; ruff/eslint/semgrep run when a working tree is provided. Degrade gracefully if a tool is absent. |
| 05 AI discovery | `src/models/provider.ts` (+ `mock.ts`, `anthropic.ts`) | One interface, per-task model routing, token/cost tracking, automatic fallback to mock when no key. |
| 06 Verification | `src/pipeline/verification.ts` | The accuracy differentiator — see `ACCURACY.md`. |
| 07 Publish | `src/pipeline/publish.ts` | Review verdict, summary, inline-comment rendering, machine output. |
| 08 Learn + measure | `src/db/store.ts`, `bench/harness.ts`, `src/db/schema.sql` | Local JSON audit store; benchmark harness; production Postgres+pgvector schema. |

## Data model

The in-memory `Finding` (see `src/types.ts`) is the blueprint's finding record.
The persisted shape (`src/db/schema.sql`) adds tenancy (`tenants`,
`repositories`), review metadata (`reviews`), findings, developer feedback
(`finding_feedback` — the label loop for calibration), a `code_chunks` table
with a `vector(1536)` embedding column for hybrid retrieval, and `eval_runs` for
the accuracy lab.

## Design choices

- **Modular monolith + worker-shaped boundaries.** Analyzers and the model layer
  are pure functions/adapters behind interfaces, so they can be lifted into
  separate workers (SQS-driven) without touching the pipeline contract.
- **Zero runtime dependencies.** The core runs on Node stdlib only; the sole dev
  dependencies are `typescript` and `@types/node`. This keeps the accuracy lab
  reproducible and the supply chain small.
- **Deterministic-first.** Deterministic tools are high-trust evidence; the AI
  pass is additive and always verified against them.
- **Everything is traced.** Each run records per-stage latency, token usage and
  estimated cost — the raw material for the cost/latency metrics the blueprint
  requires.
