/**
 * Adapters for external deterministic analyzers (ruff, eslint, semgrep).
 *
 * These run only when a working tree (repoPath) is available, since the tools
 * need real files on disk. Each adapter degrades gracefully: a missing tool, a
 * non-zero exit, or unparseable output yields zero findings rather than failing
 * the review. Findings are later restricted to changed lines by the context stage.
 */

import { execFile } from "node:child_process";
import { join, isAbsolute } from "node:path";
import type {
  FileDiff,
  FindingCategory,
  RawFinding,
  Severity,
} from "../types.js";
import { isJsFamily } from "../util/lang.js";
import { log } from "../util/logger.js";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as unknown as { code: number }).code ?? 1)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function toolExists(cmd: string, cwd: string): Promise<boolean> {
  const res = await run("bash", ["-lc", `command -v ${cmd}`], cwd, 5_000);
  return res.code === 0 && res.stdout.trim().length > 0;
}

function absFile(repoPath: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(repoPath, rel);
}

function mapSeverity(s: string, fallback: Severity): Severity {
  const v = s.toLowerCase();
  if (v.includes("error") || v === "high" || v === "critical") return "high";
  if (v.includes("warn") || v === "medium") return "medium";
  if (v === "info" || v.includes("note") || v === "low") return "low";
  return fallback;
}

/** ruff --output-format json for Python files. */
async function runRuff(repoPath: string, files: FileDiff[]): Promise<RawFinding[]> {
  const pyFiles = files.filter((f) => f.language === "python" && f.changeType !== "deleted");
  if (pyFiles.length === 0) return [];
  if (!(await toolExists("ruff", repoPath))) {
    log.debug("ruff not available, skipping");
    return [];
  }
  const paths = pyFiles.map((f) => absFile(repoPath, f.newPath));
  const res = await run("ruff", ["check", "--output-format", "json", "--force-exclude", ...paths], repoPath);
  const findings: RawFinding[] = [];
  try {
    const items = JSON.parse(res.stdout || "[]") as Array<{
      code: string | null;
      message: string;
      filename: string;
      location: { row: number; column: number };
      end_location?: { row: number };
    }>;
    for (const it of items) {
      const code = it.code ?? "RUFF";
      const category: FindingCategory =
        code.startsWith("S") ? "security" : code.startsWith("B") ? "correctness" : "maintainability";
      findings.push({
        ruleId: `ruff/${code}`,
        category,
        severity: code.startsWith("S") ? "high" : "low",
        confidence: 0.85,
        filePath: relativize(repoPath, it.filename),
        startLine: it.location.row,
        endLine: it.end_location?.row ?? it.location.row,
        problem: `${code}: ${it.message}`,
        evidence: [`ruff ${code} at ${relativize(repoPath, it.filename)}:${it.location.row}`],
        impact: "Reported by ruff static analysis.",
        source: "ruff",
      });
    }
  } catch (err) {
    log.debug("ruff output parse failed:", (err as Error).message);
  }
  return findings;
}

/** eslint -f json for JS/TS files. */
async function runEslint(repoPath: string, files: FileDiff[]): Promise<RawFinding[]> {
  const jsFiles = files.filter((f) => isJsFamily(f.language) && f.changeType !== "deleted");
  if (jsFiles.length === 0) return [];
  if (!(await toolExists("eslint", repoPath))) {
    log.debug("eslint not available, skipping");
    return [];
  }
  const paths = jsFiles.map((f) => absFile(repoPath, f.newPath));
  const res = await run("eslint", ["-f", "json", "--no-error-on-unmatched-pattern", ...paths], repoPath);
  const findings: RawFinding[] = [];
  try {
    const reports = JSON.parse(res.stdout || "[]") as Array<{
      filePath: string;
      messages: Array<{
        ruleId: string | null;
        severity: number;
        message: string;
        line: number;
        endLine?: number;
      }>;
    }>;
    for (const rep of reports) {
      for (const msg of rep.messages) {
        if (!msg.ruleId) continue; // skip parse errors / config noise
        const sev: Severity = msg.severity === 2 ? "medium" : "low";
        findings.push({
          ruleId: `eslint/${msg.ruleId}`,
          category: /security|no-eval|no-unsafe/.test(msg.ruleId) ? "security" : "maintainability",
          severity: sev,
          confidence: 0.8,
          filePath: relativize(repoPath, rep.filePath),
          startLine: msg.line,
          endLine: msg.endLine ?? msg.line,
          problem: `${msg.ruleId}: ${msg.message}`,
          evidence: [`eslint ${msg.ruleId} at ${relativize(repoPath, rep.filePath)}:${msg.line}`],
          impact: "Reported by eslint.",
          source: "eslint",
        });
      }
    }
  } catch (err) {
    log.debug("eslint output parse failed:", (err as Error).message);
  }
  return findings;
}

/** semgrep --json (if installed). Auto-config, best effort. */
async function runSemgrep(repoPath: string, files: FileDiff[]): Promise<RawFinding[]> {
  const targets = files.filter((f) => f.changeType !== "deleted");
  if (targets.length === 0) return [];
  if (!(await toolExists("semgrep", repoPath))) {
    log.debug("semgrep not available, skipping");
    return [];
  }
  const paths = targets.map((f) => absFile(repoPath, f.newPath));
  const res = await run(
    "semgrep",
    ["--config", "auto", "--json", "--quiet", "--timeout", "30", ...paths],
    repoPath,
    120_000,
  );
  const findings: RawFinding[] = [];
  try {
    const parsed = JSON.parse(res.stdout || "{}") as {
      results?: Array<{
        check_id: string;
        path: string;
        start: { line: number };
        end: { line: number };
        extra: { message: string; severity: string };
      }>;
    };
    for (const r of parsed.results ?? []) {
      findings.push({
        ruleId: `semgrep/${r.check_id.split(".").pop() ?? r.check_id}`,
        category: "security",
        severity: mapSeverity(r.extra.severity, "medium"),
        confidence: 0.82,
        filePath: relativize(repoPath, r.path),
        startLine: r.start.line,
        endLine: r.end.line,
        problem: r.extra.message,
        evidence: [`semgrep ${r.check_id} at ${relativize(repoPath, r.path)}:${r.start.line}`],
        impact: "Reported by semgrep static analysis.",
        source: "semgrep",
      });
    }
  } catch (err) {
    log.debug("semgrep output parse failed:", (err as Error).message);
  }
  return findings;
}

function relativize(repoPath: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : join(repoPath, filePath);
  const base = repoPath.endsWith("/") ? repoPath : repoPath + "/";
  return abs.startsWith(base) ? abs.slice(base.length) : filePath;
}

export async function runExternalAnalyzers(
  repoPath: string | undefined,
  files: FileDiff[],
): Promise<RawFinding[]> {
  if (!repoPath) {
    log.debug("no repoPath; external analyzers skipped (builtin rules still run)");
    return [];
  }
  const [ruff, eslint, semgrep] = await Promise.all([
    runRuff(repoPath, files).catch(() => []),
    runEslint(repoPath, files).catch(() => []),
    runSemgrep(repoPath, files).catch(() => []),
  ]);
  return [...ruff, ...eslint, ...semgrep];
}
