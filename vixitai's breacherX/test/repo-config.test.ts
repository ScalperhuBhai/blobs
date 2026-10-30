import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../src/util/diff.js";
import {
  matchGlob,
  isIgnored,
  filterIgnoredFiles,
  runCustomRules,
  applyRuleOverrides,
  applyRepoConfig,
  type RepoConfig,
} from "../src/config/repo.js";
import { loadConfig } from "../src/config.js";
import type { RawFinding } from "../src/types.js";

test("glob matcher handles *, **, ?", () => {
  assert.ok(matchGlob("dist/app.js", "dist/**"));
  assert.ok(matchGlob("src/a.min.js", "**/*.min.js"));
  assert.ok(matchGlob("vendor/x/y.ts", "vendor/**"));
  assert.ok(matchGlob("a.ts", "a.?s"));
  assert.ok(!matchGlob("src/app.ts", "dist/**"));
  assert.ok(!matchGlob("src/app.ts", "**/*.min.js"));
});

test("isIgnored / filterIgnoredFiles drop matching files", () => {
  const diff = parseUnifiedDiff(`diff --git a/dist/bundle.js b/dist/bundle.js
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1,1 +1,2 @@
 x
+y
diff --git a/src/real.ts b/src/real.ts
--- a/src/real.ts
+++ b/src/real.ts
@@ -1,1 +1,2 @@
 a
+b
`);
  const repo: RepoConfig = { ignorePaths: ["dist/**"] };
  assert.ok(isIgnored("dist/bundle.js", repo.ignorePaths));
  const kept = filterIgnoredFiles(diff.files, repo);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.newPath, "src/real.ts");
});

test("custom rules fire on added lines of matching language", () => {
  const diff = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
new file mode 100644
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +1,2 @@
+const x = dangerousCall();
+const y = 1;
`);
  const repo: RepoConfig = {
    customRules: [
      { id: "no-dangerous", pattern: "dangerousCall\\(", languages: ["typescript"], severity: "high", category: "security", message: "Do not call dangerousCall()" },
    ],
  };
  const findings = runCustomRules(diff.files[0]!, repo);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.ruleId, "repo/no-dangerous");
  assert.equal(findings[0]!.severity, "high");
  assert.equal(findings[0]!.startLine, 1);
});

test("invalid custom regex is skipped, not thrown", () => {
  const diff = parseUnifiedDiff(`diff --git a/a.ts b/a.ts
new file mode 100644
--- /dev/null
+++ b/a.ts
@@ -0,0 +1,1 @@
+foo
`);
  const repo: RepoConfig = { customRules: [{ id: "bad", pattern: "(", message: "broken" }] };
  assert.doesNotThrow(() => runCustomRules(diff.files[0]!, repo));
  assert.equal(runCustomRules(diff.files[0]!, repo).length, 0);
});

test("disabledRules and severityOverrides are applied", () => {
  const findings: RawFinding[] = [
    { ruleId: "js/leftover-debug", category: "maintainability", severity: "info", confidence: 0.5, filePath: "a.ts", startLine: 1, endLine: 1, problem: "p", evidence: [], impact: "i", source: "builtin" },
    { ruleId: "sql/string-built-query", category: "security", severity: "high", confidence: 0.6, filePath: "a.ts", startLine: 2, endLine: 2, problem: "p", evidence: [], impact: "i", source: "builtin" },
  ];
  const repo: RepoConfig = { disabledRules: ["js/leftover-debug"], severityOverrides: { "sql/string-built-query": "critical" } };
  const out = applyRuleOverrides(findings, repo);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.ruleId, "sql/string-built-query");
  assert.equal(out[0]!.severity, "critical");
});

test("applyRepoConfig merges thresholds over base", () => {
  const base = loadConfig({ minConfidence: 0.55, maxFindings: 50 });
  const merged = applyRepoConfig(base, { minConfidence: 0.8, maxFindings: 10 });
  assert.equal(merged.minConfidence, 0.8);
  assert.equal(merged.maxFindings, 10);
  // unspecified fields fall through
  assert.equal(merged.changedLinesOnly, base.changedLinesOnly);
});
