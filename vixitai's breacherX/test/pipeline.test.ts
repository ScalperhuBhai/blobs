import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "../src/pipeline/pipeline.js";
import { loadConfig } from "../src/config.js";
import { runBenchmark } from "../bench/harness.js";

const DIFF = `diff --git a/app/run.py b/app/run.py
new file mode 100644
--- /dev/null
+++ b/app/run.py
@@ -0,0 +1,4 @@
+import os
+def run(cmd):
+    result = eval(cmd)
+    return result
`;

test("end-to-end review flags eval and requests changes", async () => {
  const config = loadConfig({ modelProvider: "mock" });
  const result = await runReview({ diffText: DIFF, reviewId: "t1" }, config);
  assert.ok(result.findings.length >= 1);
  const evalFinding = result.findings.find((f) => f.ruleId.includes("eval"));
  assert.ok(evalFinding, "should flag eval");
  assert.equal(evalFinding!.filePath, "app/run.py");
  assert.equal(evalFinding!.startLine, 3);
  assert.equal(result.reviewStatus, "changes_requested");
  // Trace covers all stages.
  const stages = result.trace.map((t) => t.stage);
  for (const s of ["ingest", "context", "deterministic", "discovery", "verification"]) {
    assert.ok(stages.includes(s), `missing stage ${s}`);
  }
});

test("clean diff is approved with no findings", async () => {
  const clean = `diff --git a/src/clean.ts b/src/clean.ts
--- a/src/clean.ts
+++ b/src/clean.ts
@@ -1,1 +1,3 @@
 export const a = 1;
+export const b = 2;
+export const c = 3;
`;
  const result = await runReview({ diffText: clean, reviewId: "t2" }, loadConfig({}));
  assert.equal(result.findings.length, 0);
  assert.equal(result.reviewStatus, "approved");
});

test("benchmark meets precision floor on seed set", async () => {
  const report = await runBenchmark("regression", loadConfig({ modelProvider: "mock" }));
  // The seed set is tuned so deterministic rules give high precision.
  assert.ok(report.metrics.precision >= 0.9, `precision ${report.metrics.precision}`);
  assert.ok(report.metrics.recall >= 0.5, `recall ${report.metrics.recall}`);
  // The hard-miss case must register as a false negative (honest recall).
  assert.ok(report.metrics.totalFn >= 1, "expected at least one honest miss");
});
