import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../src/util/diff.js";
import { verifyFindings } from "../src/pipeline/verification.js";
import { loadConfig } from "../src/config.js";
import type { FileDiff, RawFinding } from "../src/types.js";

const DIFF = `diff --git a/x.py b/x.py
new file mode 100644
--- /dev/null
+++ b/x.py
@@ -0,0 +1,3 @@
+import os
+x = eval(data)
+y = 2
`;

function headMap() {
  const diff = parseUnifiedDiff(DIFF);
  const file = diff.files[0] as FileDiff;
  const m = new Map<string, { file: FileDiff; headContent?: string }>();
  m.set(file.newPath, { file });
  return m;
}

function raw(partial: Partial<RawFinding>): RawFinding {
  return {
    ruleId: "test/rule",
    category: "security",
    severity: "high",
    confidence: 0.7,
    filePath: "x.py",
    startLine: 2,
    endLine: 2,
    problem: "p",
    evidence: [],
    impact: "i",
    source: "model",
    ...partial,
  };
}

test("rejects findings outside changed lines in changed-lines-only mode", () => {
  const config = loadConfig({ changedLinesOnly: true });
  const out = verifyFindings([raw({ startLine: 999, endLine: 999, source: "builtin" })], headMap(), config);
  assert.equal(out.published.length, 0);
  assert.equal(out.suppressed[0]!.verificationStatus, "rejected");
});

test("deterministic finding on a changed line is verified and published", () => {
  const config = loadConfig({});
  const out = verifyFindings([raw({ source: "builtin", ruleId: "builtin/eval" })], headMap(), config);
  assert.equal(out.published.length, 1);
  assert.equal(out.published[0]!.verificationStatus, "verified");
});

test("uncorroborated model claim is penalized vs deterministic", () => {
  const config = loadConfig({});
  const modelOnly = verifyFindings([raw({ source: "model", confidence: 0.7 })], headMap(), config);
  const deterministic = verifyFindings([raw({ source: "builtin", confidence: 0.7 })], headMap(), config);
  const mConf = modelOnly.published[0]?.calibratedConfidence ?? modelOnly.suppressed[0]!.calibratedConfidence;
  const dConf = deterministic.published[0]!.calibratedConfidence;
  assert.ok(dConf > mConf, `deterministic ${dConf} should exceed model-only ${mConf}`);
});

test("model claim corroborated by deterministic becomes verified", () => {
  const config = loadConfig({});
  const out = verifyFindings(
    [
      raw({ source: "model", ruleId: "model/eval", confidence: 0.5 }),
      raw({ source: "builtin", ruleId: "builtin/eval", confidence: 0.75 }),
    ],
    headMap(),
    config,
  );
  const modelFinding = out.published.find((f) => f.source === "model");
  assert.ok(modelFinding, "model finding should be published");
  assert.equal(modelFinding!.verificationStatus, "verified");
  assert.ok(modelFinding!.calibratedConfidence >= 0.8);
});

test("exact duplicates collapse to one", () => {
  const config = loadConfig({});
  const out = verifyFindings(
    [
      raw({ source: "builtin", ruleId: "builtin/eval", confidence: 0.6 }),
      raw({ source: "builtin", ruleId: "builtin/eval", confidence: 0.75 }),
    ],
    headMap(),
    config,
  );
  assert.equal(out.published.length, 1);
  assert.equal(out.published[0]!.confidence, 0.75);
});
