import { test } from "node:test";
import assert from "node:assert/strict";
import { indexSymbols, enclosingSymbol, changedSymbols } from "../src/context/symbols.js";
import { extractImports } from "../src/context/imports.js";
import { chunkFile, tokenize, BM25Retriever, buildRetriever } from "../src/context/retrieval.js";

const TS = `import { foo } from "./foo";
import bar from "bar";

export class Service {
  constructor(private db: Db) {}

  async charge(userId: string, amount: number) {
    const q = "SELECT * FROM x";
    return this.db.run(q);
  }
}

export function helper(a: number): number {
  return a + 1;
}
`;

const PY = `import os
from .models import User

def authorize(user, resource):
    if not user.is_admin:
        return allow(resource)
    return deny(resource)

class Handler:
    def run(self, cmd):
        return eval(cmd)
`;

test("indexes TS class, method and function with ranges", () => {
  const syms = indexSymbols(TS, "typescript");
  const names = syms.map((s) => s.name);
  assert.ok(names.includes("Service"));
  assert.ok(names.includes("charge"));
  assert.ok(names.includes("helper"));
  const charge = syms.find((s) => s.name === "charge")!;
  assert.equal(charge.kind, "method");
  // charge spans its body (lines 7-10 roughly)
  assert.ok(charge.startLine >= 7 && charge.endLine >= charge.startLine);
});

test("enclosing + changed symbols map lines to symbols (TS)", () => {
  const syms = indexSymbols(TS, "typescript");
  const q = enclosingSymbol(syms, 8); // the SELECT line inside charge
  assert.equal(q?.name, "charge");
  const touched = changedSymbols(syms, [8, 14]); // charge + helper
  const touchedNames = touched.map((s) => s.name);
  assert.ok(touchedNames.includes("charge"));
  assert.ok(touchedNames.includes("helper"));
});

test("indexes Python def/class/method by indentation", () => {
  const syms = indexSymbols(PY, "python");
  const authorize = syms.find((s) => s.name === "authorize")!;
  assert.equal(authorize.kind, "function");
  const run = syms.find((s) => s.name === "run")!;
  assert.equal(run.kind, "method");
  const handler = syms.find((s) => s.name === "Handler")!;
  assert.equal(handler.kind, "class");
  // The eval line is inside run()
  assert.equal(enclosingSymbol(syms, 11)?.name, "run");
});

test("extracts imports for TS and Python", () => {
  const ts = extractImports(TS, "typescript").map((i) => i.module);
  assert.ok(ts.includes("./foo"));
  assert.ok(ts.includes("bar"));
  assert.equal(extractImports(TS, "typescript").find((i) => i.module === "./foo")?.local, true);

  const py = extractImports(PY, "python").map((i) => i.module);
  assert.ok(py.includes("os"));
  assert.ok(py.includes(".models"));
});

test("chunking and tokenize behave", () => {
  const chunks = chunkFile("a.ts", TS, 6, 2);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0]!.filePath, "a.ts");
  const toks = tokenize("const userId = getUserId();");
  assert.ok(toks.includes("userid") || toks.includes("getuserid"));
  assert.ok(!toks.includes("const")); // stopword
});

test("BM25 retriever ranks the relevant chunk first", () => {
  const r = buildRetriever([
    { filePath: "auth.py", content: "def authorize(user):\n    return user.is_admin" },
    { filePath: "math.py", content: "def add(a, b):\n    return a + b" },
  ]);
  const hits = r.retrieve("authorize admin user permission", 2);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.chunk.filePath, "auth.py");
});

test("retriever tolerates empty query / docs", () => {
  const r = new BM25Retriever([]);
  assert.deepEqual(r.retrieve("anything", 3), []);
});
