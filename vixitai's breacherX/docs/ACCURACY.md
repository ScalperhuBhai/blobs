# Accuracy engineering

> Optimize for verified useful findings, not the number of comments. Model
> confidence is not proof.

This is where BreacherX earns trust. Raw candidate findings — from deterministic
analyzers and the AI discovery pass — are never published directly. They pass
through `src/pipeline/verification.ts`.

## The verification stage, step by step

1. **Exact-duplicate collapse.** Findings with the same `ruleId + file +
   startLine` collapse to the most confident one.

2. **Range validation.** `startLine ≤ endLine`, and the start line must exist in
   the file (checked against the changed-line set and head-file length). Invalid
   ranges → `rejected`. This directly implements the blueprint rule *"validate
   comment ranges against the current diff."*

3. **Introduced-by-change.** In changed-lines-only mode (default), a finding must
   overlap lines the diff actually added/changed. Pre-existing code → `rejected`.

4. **Corroboration.** Two findings corroborate when they share a file, category,
   and overlapping/adjacent lines. The sources are then weighed:
   - *Deterministic* finding (builtin/ruff/eslint/semgrep): trusted →
     `verified`.
   - *Model* finding **corroborated by a deterministic tool**: promoted to
     `verified`, confidence floored at 0.80.
   - *Model* finding **alone**: confidence multiplied by 0.75 (the "confidence is
     not proof" penalty) → `plausible` or `unverified`.

5. **Severity-aware publish threshold.** The base threshold
   (`BREACHERX_MIN_CONFIDENCE`, default 0.55) is discounted for high-impact
   severities so important low-frequency bugs are not suppressed, and
   `unverified` findings must clear an extra margin. This encodes *"suppress weak
   claims without hiding important low-frequency bugs."*

6. **Ranking + cap.** Published findings are ordered by
   `severity × calibratedConfidence × statusWeight` and truncated to
   `BREACHERX_MAX_FINDINGS`; the remainder move to `suppressed` (kept for audit).

Everything that is rejected or suppressed is retained on the `ReviewResult` so a
reviewer — or a future calibration job — can inspect what was filtered and why.

## Calibration is not faked

The mock provider deliberately emits findings with *imperfect* confidence and a
different rule set from the deterministic engine, so the corroboration and
calibration logic has real work to do. Swapping in the Anthropic provider
changes only the candidate generator; the verification contract is identical.

## Benchmarking — the release gate

`bench/harness.ts` runs the pipeline over a versioned labeled dataset
(`bench/datasets/<set>/cases.json`) and reports:

- **Precision** — share of published findings that match a labeled defect.
- **Recall** — share of labeled defects found.
- **F1** — harmonic mean.
- **Localization** — share of true positives within ±1 line of the label.
- **Latency / cost** — summed from the per-stage trace.

```bash
node dist/src/index.js bench --set regression
node dist/src/index.js bench --set regression --format json --min-precision 0.9
```

`--min-precision` makes the command a CI gate: it exits non-zero when precision
drops below the floor. This is the mechanism behind the blueprint's rule that
*no model, prompt, threshold, analyzer rule or verifier change ships without a
reproducible comparison against the pinned set.*

### The seed dataset

Five cases: three catchable-defect cases, one clean change (false-positive
guard), and `auth-inverted-check-hard-miss` — an inverted authorization check
that no regex or current heuristic catches. It is kept as a permanent **honest
false negative** so the suite reports realistic recall (85.7%) rather than a
vanity 100%. Closing that gap is exactly what a real AI discovery pass is for;
the benchmark will show whether it does.

## The feedback → calibration loop

Developer feedback closes the loop:

```bash
# A developer marks a published finding:
breacherx feedback --review "acme/blobs#42@abc1234" --finding fnd_py-bare-except_9_3 --label false_positive
# Fit per-rule precision from all accumulated feedback and write calibration.json:
breacherx calibrate --min-samples 5
```

`calibrate` joins feedback labels with stored runs to recover each finding's
rule/source, then estimates each rule's historical precision (Laplace-smoothed,
with a source-level fallback when a rule has too few samples). The review
pipeline loads `calibration.json` and **blends** that measured precision into
each finding's confidence (`0.5 × pipeline_confidence + 0.5 × measured_precision`).
A rule that developers keep rejecting sinks below the publish threshold on its
own — measured, not hand-tuned. This is the mechanical form of "calibrate
against held-out labeled examples."

### Growing the suite

Per the blueprint, feed the private regression suite from shadow mode: verified
bugs, important misses, false positives, and fixes to previous failures. Add
each as a new case with a labeled `expected` entry (file, line, tolerance,
optional category and `ruleIdContains`). Bump `version` when the label set
changes so eval runs remain comparable.
