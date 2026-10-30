# Security — launch blockers and current status

The blueprint names security requirements as **launch blockers**. This file
tracks each against what BreacherX implements today and what remains for the
GitHub-App and sandboxed-execution phases.

| Requirement | Status | Where / what's needed |
|---|---|---|
| Least-privilege Git provider permissions | ⏳ design | GitHub App scopes defined in roadmap; the current CLI reads local diffs only, no remote write. |
| Signed webhooks + replay protection | ⏳ design | HMAC signature verification + delivery-id dedupe belongs in the ingestion service (Phase 1 GitHub App). |
| Strict tenant isolation | ⏳ schema | `tenants`/`repositories` scoping is in `src/db/schema.sql`; row-level enforcement is added with the API layer. |
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
- **No code execution of the change.** Dynamic test reproduction (blueprint
  stage 06) is intentionally not wired into the in-process pipeline because it
  would run untrusted code; it is reserved for an isolated worker with no
  production secrets and restricted egress.
