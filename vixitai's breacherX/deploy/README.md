# Deploying BreacherX

Three supported shapes, smallest to largest.

## 1. CI check (no server) — GitHub Actions

Copy `deploy/workflows/pr-review.yml` to `.github/workflows/` in the repo you
want reviewed. On each PR it computes the diff, runs the reviewer, and posts a
single sticky review comment using the built-in `GITHUB_TOKEN`. Set
`ANTHROPIC_API_KEY` as a repo secret and switch `BREACHERX_MODEL_PROVIDER` to
`anthropic` for real model output.

Also copy `deploy/workflows/ci.yml` to run the build, tests, and the accuracy
release gate (`bench --min-precision`) on every push.

## 2. Webhook service — Docker

```bash
# Build the control-plane image (context = project dir):
docker build -f deploy/Dockerfile -t breacherx:latest .

# Or the full stack (server + pgvector Postgres):
docker compose -f deploy/docker-compose.yml up --build
```

Configure a GitHub App (or repo webhook) to POST `pull_request` events to
`https://<host>/webhook` with the secret set in `BREACHERX_WEBHOOK_SECRET`.
Grant the token least privilege: read repository contents + pull requests,
write pull-request reviews. Nothing else.

Endpoints: `GET /healthz`, `POST /webhook`, `GET /reviews`, `GET /reviews/:id`,
`GET /dlq`.

## 3. Production (AWS sketch, per the blueprint)

- **Compute:** ECS Fargate (or EC2) for the API/control plane; a separate
  disposable worker pool for analyzers and test reproduction.
- **Queue:** replace `InMemoryQueue` with SQS + a dead-letter queue (the `Queue`
  interface in `src/server/queue.ts` is SQS-shaped).
- **Data:** RDS PostgreSQL + pgvector (`src/db/schema.sql`); S3 for artifacts.
- **Isolation:** run untrusted analysis/test execution in locked-down workers —
  no production secrets, restricted egress, CPU/mem/time limits. See
  `docs/SECURITY.md`.
- **Observability:** OpenTelemetry → CloudWatch; the per-stage trace and cost
  fields on every `ReviewResult` are the raw signal.

See `docs/BLUEPRINT.md` §5 for the credit/budget envelopes.
