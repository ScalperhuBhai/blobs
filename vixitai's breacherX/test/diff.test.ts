import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, countChangedLines } from "../src/util/diff.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -5,3 +5,5 @@ export function f() {
   const x = 1;
   const y = 2;
   const z = 3;
+  const w = eval("x");
+  return w;
diff --git a/new.py b/new.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+import os
+print(os.getcwd())
`;

test("parses multiple files", () => {
  const diff = parseUnifiedDiff(SAMPLE);
  assert.equal(diff.files.length, 2);
  assert.equal(diff.files[0]!.newPath, "src/a.ts");
  assert.equal(diff.files[0]!.language, "typescript");
  assert.equal(diff.files[1]!.changeType, "added");
  assert.equal(diff.files[1]!.language, "python");
});

test("computes new-file line numbers for added lines", () => {
  const diff = parseUnifiedDiff(SAMPLE);
  const tsFile = diff.files[0]!;
  // Hunk starts at new line 5: lines 5,6,7 context; 8,9 added.
  assert.ok(tsFile.changedNewLines.has(8));
  assert.ok(tsFile.changedNewLines.has(9));
  assert.ok(!tsFile.changedNewLines.has(5));
});

test("counts changed lines across files", () => {
  const diff = parseUnifiedDiff(SAMPLE);
  // ts: 2 added, py: 2 added
  assert.equal(countChangedLines(diff), 4);
});

test("tolerates empty input", () => {
  const diff = parseUnifiedDiff("");
  assert.equal(diff.files.length, 0);
});
