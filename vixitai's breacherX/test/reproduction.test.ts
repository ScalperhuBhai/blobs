import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { reproduceTests, summarizeTestRun } from "../src/pipeline/reproduction.js";

test("disabled reproduction does not run", async () => {
  const r = await reproduceTests({ enabled: false, repoPath: tmpdir(), command: "true", timeoutMs: 5000 });
  assert.equal(r.ran, false);
  assert.equal(r.reason, "disabled");
});

test("missing repoPath or command is reported, not thrown", async () => {
  assert.equal((await reproduceTests({ enabled: true, command: "true", timeoutMs: 5000 })).reason, "no repoPath");
  assert.equal((await reproduceTests({ enabled: true, repoPath: tmpdir(), timeoutMs: 5000 })).reason, "no test command");
});

test("runs a passing command", async () => {
  const r = await reproduceTests({ enabled: true, repoPath: tmpdir(), command: "true", timeoutMs: 5000 });
  assert.equal(r.ran, true);
  assert.equal(r.passed, true);
  assert.match(summarizeTestRun(r), /tests passed/);
});

test("runs a failing command", async () => {
  const r = await reproduceTests({ enabled: true, repoPath: tmpdir(), command: "false", timeoutMs: 5000 });
  assert.equal(r.ran, true);
  assert.equal(r.passed, false);
  assert.match(summarizeTestRun(r), /tests failed/);
});

test("does not use a shell (argv split)", async () => {
  // If this were shell-interpreted, the ';' would run a second command. With
  // argv-split, "echo" just prints the literal args and exits 0.
  const r = await reproduceTests({ enabled: true, repoPath: tmpdir(), command: "echo hi ; echo pwned", timeoutMs: 5000 });
  assert.equal(r.ran, true);
  assert.equal(r.passed, true);
  assert.ok(!(r.output ?? "").includes("pwned") || (r.output ?? "").includes("; echo pwned"));
});
