# BreacherX — VixitAI's evidence-based AI code reviewer

> Build a CodeRabbit-class AI code review platform. Catch real defects with
> evidence. Keep false positives low. Make every review measurable.

BreacherX is a runnable implementation of the
[VixitAI Code Review Build Blueprint](./docs/BLUEPRINT.md) — specifically its
**Phase 0 (accuracy lab)** and **Phase 1 (end-to-end review MVP)**. It is not a
prompt that reads a diff; it is a review *pipeline* that combines deterministic
analyzers, a pluggable AI discovery pass, and an independent **verification**
stage that treats model confidence as a claim to be checked, not proof.

It runs today with **zero runtime dependencies** (pure Node stdlib) and **no API
key** — an offline heuristic provider stands in for the LLM so the whole
pipeline, benchmark included, works out of the box. Point it at Anthropic for
real model discovery by setting two env vars.

```
ingest → repo context → deterministic checks → AI discovery → verification → publish → learn/measure
```

---

## Quickstart

```bash
cd "vixitai's breacherX"
npm install          # installs typescript + @types/node (dev only)
npm run build        # compiles to dist/ with tsc
npm test             # 12 unit + integration tests

# Review a unified diff (git diff / PR patch). Prints Markdown.
npm run demo
# ...or directly:
node dist/src/index.js review examples/sample.diff --format md

# Review the current staged changes of any repo:
git -C /path/to/repo diff --staged | node dist/src/index.js review - --repo /path/to/repo

# Run the accuracy benchmark (the release gate):
node dist/src/index.js bench --set regression
```

No global install needed; the project builds with the `tsc` on your `PATH` and
runs on Node ≥ 22.6.

---

## Why this is more than "ask a model to review a diff"

The blueprint's core principle is **optimize for verified useful findings, not
the number of comments**. BreacherX enforces that mechanically:

| Guard | Where | What it does |
|---|---|---|
| Changed-lines-only | `pipeline/context.ts` | Findings must land on lines the diff introduced, not pre-existing code. |
| Range validation | `pipeline/verification.ts` | A reported line range must actually exist in the file; bad ranges are rejected. |
| Corroboration | `pipeline/verification.ts` | A model claim backed by a deterministic tool (ruff/eslint/semgrep/builtin) is promoted to `verified`; an uncorroborated model claim is penalized. |
| Calibration | `pipeline/verification.ts` | "Model confidence is not proof" — uncorroborated model confidence is discounted before the publish threshold. |
| Severity-aware thresholds | `pipeline/verification.ts` | Critical/high findings get a lower bar so important low-frequency bugs are not suppressed. |
| Deduplication | `pipeline/verification.ts` | Exact duplicates collapse; nearby same-category findings corroborate instead of double-reporting. |
| Prompt-injection defense | `models/anthropic.ts` | Diff/file content is wrapped as untrusted data and the system prompt refuses embedded instructions. |

Every finding carries the blueprint's **finding record**: `rule_id, severity,
confidence, file_path, start_line, end_line, problem, evidence[], impact,
suggested_patch?, introduced_by_change, verification_status, analyzer_result,
test_result, model_version`.

---

## What you get

- **CLI** (`breacherx`) with `review`, `bench`, and `runs` commands, plus
  Markdown / JSON / text output and a CI-friendly exit code (non-zero on
  `changes_requested`).
- **Deterministic analyzers**: a built-in, dependency-free rule engine (secrets,
  `eval`, `shell=True`, SQL-string-building, bare `except`, mutable default
  args, loose equality, leftover debug, …) plus adapters that shell out to
  **ruff**, **eslint**, and **semgrep** when a working tree is available.
- **Pluggable model layer**: `MockProvider` (offline heuristic) and
  `AnthropicProvider` (real Messages API), behind one interface with per-task
  model routing and token/cost tracking.
- **Verification engine**: the accuracy differentiator described above.
- **Benchmark harness**: runs a versioned labeled dataset and reports
  precision / recall / F1 / localization / latency / cost. Ships with a seed
  regression set including a deliberately hard semantic miss so recall stays
  honest.
- **Persistence**: a filesystem run store for local auditing, plus the
  production **PostgreSQL + pgvector** schema (`src/db/schema.sql`).

Sample benchmark output on the seed set:

```
Precision 100.0%  Recall 85.7%  F1 92.3%  Localization 100.0%
TP=6 FP=0 FN=1  avg 1ms  cost $0.0000
```

(The one false negative is an inverted-auth-check case no regex catches — kept
on purpose to represent the recall frontier real AI passes must close.)

---

## Using a real model

```bash
cp .env.example .env
# edit .env:
#   BREACHERX_MODEL_PROVIDER=anthropic
#   ANTHROPIC_API_KEY=sk-ant-...
#   BREACHERX_DISCOVERY_MODEL=claude-haiku-4-5
node dist/src/index.js review examples/sample.diff --provider anthropic
```

The Anthropic pass runs one discovery call per changed file, parses a strict
JSON finding array, and feeds the results into the same verification stage as
the deterministic analyzers — so model output is corroborated and calibrated,
never trusted blindly. If the key is missing, BreacherX logs a warning and falls
back to the mock provider so the pipeline always completes.

---

## Documentation

- [`docs/BLUEPRINT.md`](./docs/BLUEPRINT.md) — the source blueprint, transcribed.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how each blueprint stage maps to code.
- [`docs/ACCURACY.md`](./docs/ACCURACY.md) — the verification + benchmark strategy.
- [`docs/SECURITY.md`](./docs/SECURITY.md) — launch-blocker security requirements and status.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — the build roadmap and what is / isn't done here.

## Status & honesty note

This is a working **MVP of the review loop and accuracy lab**, not a finished
CodeRabbit competitor. The GitHub App ingestion, tenant isolation, sandboxed
execution of untrusted code, AST/dependency-graph context, and shadow-mode
evaluation are specified in the docs and scaffolded in the schema, but the
running system here is the pipeline core. Feature parity is not accuracy parity;
nothing here claims parity with any vendor. Measure before scaling.
