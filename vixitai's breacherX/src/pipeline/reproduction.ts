/**
 * Test reproduction (Phase 3 — optional, security-sensitive).
 *
 * The blueprint wants targeted tests run to turn a claim into evidence. Running
 * a repository's test command EXECUTES untrusted code, so this is:
 *   - OFF by default (must be explicitly enabled), and
 *   - intended for a disposable, isolated worker with no production secrets and
 *     restricted egress (see docs/SECURITY.md). Do not enable it in-process
 *     against untrusted repositories.
 *
 * It runs the project's own configured test command (no shell, argv-split, hard
 * timeout) and reports a signal. Per the blueprint's verification rules, a test
 * outcome is evidence, not automatic proof — we record it, we do not treat a
 * green run as proof that a finding is wrong.
 */

import { execFile } from "node:child_process";

export interface ReproductionOptions {
  enabled: boolean;
  repoPath?: string;
  command?: string;
  timeoutMs: number;
}

export interface TestRunResult {
  ran: boolean;
  passed?: boolean;
  command?: string;
  durationMs: number;
  /** Tail of combined output, for the audit trail. */
  output?: string;
  /** Why it did not run, when ran=false. */
  reason?: string;
}

/** Split a command string into argv without invoking a shell. */
function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export async function reproduceTests(opts: ReproductionOptions): Promise<TestRunResult> {
  const start = Date.now();
  if (!opts.enabled) return { ran: false, durationMs: 0, reason: "disabled" };
  if (!opts.repoPath) return { ran: false, durationMs: 0, reason: "no repoPath" };
  if (!opts.command) return { ran: false, durationMs: 0, reason: "no test command" };

  const argv = splitCommand(opts.command);
  const cmd = argv[0];
  if (!cmd) return { ran: false, durationMs: 0, reason: "empty command" };

  return new Promise<TestRunResult>((resolve) => {
    execFile(
      cmd,
      argv.slice(1),
      { cwd: opts.repoPath, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const output = `${stdout ?? ""}${stderr ?? ""}`.slice(-4000);
        const passed = !err;
        resolve({ ran: true, passed, command: opts.command, durationMs, output });
      },
    );
  });
}

/** Human-readable one-liner for the review summary / finding testResult field. */
export function summarizeTestRun(r: TestRunResult): string {
  if (!r.ran) return `tests not run (${r.reason})`;
  return `tests ${r.passed ? "passed" : "failed"} via \`${r.command}\` in ${r.durationMs}ms`;
}
