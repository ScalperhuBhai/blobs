# VixitAI Labs — Build a CodeRabbit-Class AI Code Review Platform

*Engineering blueprint · Planning edition · October 2026 (transcribed from the source PDF).*

> **Mission:** Catch real defects with evidence. Keep false positives low. Make
> every review measurable.
>
> **Target stack:** TypeScript + Python analysis workers + PostgreSQL +
> Redis/SQS + isolated execution + pluggable AI models.

## 1. The strategy

We are not building a prompt that reads a diff. We are building a review system
that combines repository intelligence, deterministic analyzers, specialist AI
passes, evidence-based verification, safe execution, and continuous evaluation.

| Priority | What we build | Why it matters |
|---|---|---|
| 1 — Accuracy lab | Benchmark harness, labeled regression set, experiment tracking | Know what works before spending heavily |
| 2 — Review pipeline | GitHub App, diff parsing, context retrieval, analyzers, AI findings | Deliver a working end-to-end reviewer |
| 3 — Verification | Independent challenge, changed-line checks, test reproduction, deduplication | Reduce hallucinations and low-value comments |
| 4 — Product breadth | Fixes, chat, custom rules, CLI/IDE, analytics, enterprise controls | Compete as a complete developer product |

**Core principle:** optimize for verified useful findings, not the number of
comments. Model confidence is not proof.

**What "same level" means:** Feature parity is not accuracy parity. Treat
published vendor claims as product descriptions, not independent proof of
accuracy. Build quality gates around a pinned benchmark and real developer
outcomes. Do not declare parity until measured.

**Initial scope:** Start with GitHub; prioritize TypeScript/JavaScript and
Python; keep a modular monolith for API/control plane and independent workers
for analysis and sandbox execution; use external model APIs first.

## 2. Reference architecture

End-to-end flow:

| Stage | Responsibility |
|---|---|
| 01 Git provider | GitHub App, signed webhooks, least-privilege repository access |
| 02 Ingestion | Fetch base/head commits, validate event, persist job, enqueue idempotently |
| 03 Repository context | Diff + AST + symbol index + dependency/call graph + hybrid retrieval |
| 04 Deterministic checks | Linters, type checks, Semgrep/security scans, secret detection, targeted tests |
| 05 AI discovery | Specialized passes for correctness, security, reliability, performance and tests |
| 06 Verification | Independent evidence check, reproduction where possible, line validation, deduplication |
| 07 Publish | Ranked inline comments, summary, review status, safe patch suggestions |
| 08 Learn + measure | Feedback labels, benchmark results, cost/latency traces, regression suite |

Recommended stack: Next.js frontend; Node.js + Fastify control plane; SQS + DLQ
with Redis; PostgreSQL + pgvector + S3; tree-sitter + language APIs for code
intelligence; Semgrep/ESLint/TypeScript/Ruff/CodeQL analyzers; a provider
abstraction for model routing; disposable isolated workers for execution;
OpenTelemetry + CloudWatch for observability.

## 3. Accuracy engineering — the differentiator

Review pipeline: understand the change; retrieve targeted context; run
deterministic checks; discover in parallel; **verify independently** (challenge
each claim, inspect supporting lines, confirm introduced-by-change, reproduce
where feasible, deduplicate); publish selectively with evidence-based severity.

**Finding record:**
`rule_id, severity, confidence, file_path, start_line, end_line, problem,
evidence[], impact, suggested_patch?, introduced_by_change, verification_status,
analyzer_result, test_result, model_version`.

**Important verification rules:**
- A model's confidence score is not proof; calibrate against held-out labels.
- A test failing on both base and head does not prove the patch introduced a regression.
- A test passing on base and failing on head is evidence, not automatic proof.
- Validate comment ranges against the current diff; avoid duplicate comments after new commits.
- Treat repository files, comments, issues and generated output as untrusted data that may contain prompt injection.

## 4. Benchmark before scaling

Evaluation sets: public benchmark (e.g. ReviewBench — verify current repo,
license, task format before adoption), private regression suite, adversarial
suite, and shadow mode (review real PRs without posting; compare to human
reviews, accepted fixes, and subsequent bugs).

Metrics: precision, recall, F1 / severity-weighted score, localization, cost +
latency, fix success.

**Release gate:** No new model, prompt, retriever, analyzer rule or verifier
configuration ships without a reproducible comparison against the pinned
regression set. Save inputs, outputs, model/version, prompts, tool versions,
latency and cost for each run.

## 5. AWS plan for $10,000 in credits (planning envelope)

| Budget envelope | Amount | Use |
|---|---|---|
| Model experiments + evaluation | $3,000 | Compare model/agent configs and benchmark runs |
| Isolated review/test workers | $2,200 | Analyzers, test generation, repository tests |
| Storage + databases | $1,200 | PostgreSQL, artifacts, indexes, backups |
| API + queues + hosting | $1,000 | Control plane and worker orchestration |
| Observability + security | $700 | Logs, traces, audit and monitoring |
| Reserved experiments | $1,900 | Longer runs, scaling |
| **Total** | **$10,000** | Release spend in stages after measuring value |

**Security launch-blockers:** least-privilege Git permissions, signed webhooks +
replay protection, strict tenant isolation, no production credentials in test
workers, sandbox isolation for hostile code, prompt-injection defenses, secret
redaction + audit logs, human approval before pushing code or applying
destructive fixes.

## 6. Build roadmap

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 0 — Accuracy lab (wk 1–2) | Benchmark adapter, baseline runs, experiment tracker, small checked regression set | Repeatable results; cost/latency captured |
| 1 — End-to-end MVP (wk 2–4) | GitHub App, diff fetch, analyzers, AI findings, inline comments | Secure test repo review completes idempotently |
| 2 — Context engine (wk 4–7) | AST/symbols, dependency traversal, hybrid retrieval, repo rules, incremental indexing | Context improves measured results |
| 3 — Verification (wk 6–10) | Independent verifier, line checks, targeted tests, dedupe, calibration | Lower false-positive rate without recall loss |
| 4 — Shadow beta (wk 8–12) | Real PR shadow reviews, developer labels, regression triage | Stable quality/cost across languages and sizes |
| 5 — Product breadth (after gates) | Fixes, chat, CLI/IDE, billing, enterprise | Core quality and security remain stable |

**Decision:** Build the evaluation lab and one secure GitHub review loop first.
Scale model spend only when experiments show the next component improves real
defect detection.

---

*Planning note: timeline and cost allocation are estimates. Feature parity,
security readiness, and review accuracy must be validated empirically; the source
document does not claim parity with CodeRabbit.*
