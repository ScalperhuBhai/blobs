# Security — launch blockers and current status

The blueprint names security requirements as **launch blockers**. This file
tracks each against what BreacherX implements today and what remains for the
GitHub-App and sandboxed-execution phases.

| Requirement | Status | Where / what's needed |
|---|---|---|
| Least-privilege Git provider permissions | 🟡 partial | The `GitHubClient` only reads diffs and writes reviews/comments — it never pushes code. App installation scopes are documented in the roadmap. |
| Signed webhooks + replay protection | ✅ implemented | `src/github/signature.ts` verifies `X-Hub-Signature-256` (HMAC-SHA256, constant-time); the queue dedupes by delivery id and by `repo#pr@headSha` (`src/server/queue.ts`). |
| Strict tenant isolation | ⏳ schema | `tenants`/`repositories` scoping is in `src/db/schema.sql`; row-level enforcement is added with the persistent API layer. |
| No production credentials in test workers | ✅ by construction | The pipeline never injects secrets into analyzers; external analyzers run with the caller's environment and no BreacherX credentials. |
| Restrict outbound network + CPU/mem/disk/process limits | ⏳ runtime | External analyzers run via `execFile` with a timeout and bounded buffer (`src/analyzers/external.ts`); full cgroup/network sandboxing is the disposable-worker milestone. |
| Sandbox isolation for hostile code | ⏳ runtime | BreacherX **does not execute** reviewed code in the current pipeline — only static analyzers run. Test reproduction (which does run code) must happen in a disposable isolated worker, never in-process. |
| Prompt-injection defenses | ✅ implemented | `src/models/anthropic.ts` wraps all diff/file content as `untrusted="true"` and the system prompt refuses embedded instructions. Repository content is treated as data throughout. |
| Secret redaction + audit logs | 🟡 partial | The builtin analyzer *detects* secrets; run records are persisted for audit (`src/db/store.ts`). Redaction-before-logging and retention controls are added with the control plane. |
| Human approval before pushing code / applying destructive fixes | ✅ by construction | BreacherX only *suggests* patches (`suggested_patch`); it never writes to repos or applies fixes. Any future autofix must gate on human approval. |

Legend: ✅ implemented · 🟡 partial · ⏳ specified, not yet built.

## Threat-model notes

- **Untrusted input everywhere.** Diffs, file contents, identifiers, commit
  messages, issues and model output are all untrusted. The pipeline treats them
  as data and never as instructions.
- **Analyzer execution.** `ruff`/`eslint`/`semgrep` parse (and in some configs
  partially evaluate) target files. Until the disposable-worker sandbox lands,
  run BreacherX against a working tree only when you trust that tree, or disable
  external analyzers by omitting `--repo`.
- **Test reproduction is opt-in and executes code.** Dynamic test reproduction
  (`src/pipeline/reproduction.ts`) runs the project's configured test command to
  turn a claim into evidence. It is **off by default** and must be enabled
  explicitly (`--run-tests`/`--test-command` or `BREACHERX_ENABLE_TEST_REPRO`).
  It runs with no shell (argv-split), a hard timeout and a bounded buffer, and
  records the outcome as *evidence, not proof*. Enabling it against an untrusted
  repository executes that repository's code, so in production it must run in a
  disposable isolated worker with no production secrets and restricted egress —
  never in-process against untrusted input.
