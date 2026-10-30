-- BreacherX production schema (PostgreSQL + pgvector).
-- The blueprint's data layer: metadata, findings, embeddings, artifacts,
-- evaluation runs. Apply with: psql "$DATABASE_URL" -f src/db/schema.sql
-- Requires the pgvector extension for the semantic index.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenancy -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repositories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'github',
  external_id     TEXT NOT NULL,              -- e.g. github repo id
  full_name       TEXT NOT NULL,              -- owner/name
  default_branch  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_id)
);

-- Reviews -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  review_key      TEXT NOT NULL,              -- PR number / commit sha
  base_sha        TEXT,
  head_sha        TEXT,
  status          TEXT NOT NULL,              -- approved | changes_requested | commented
  files_changed   INT  NOT NULL DEFAULT 0,
  changed_lines   INT  NOT NULL DEFAULT 0,
  raw_findings    INT  NOT NULL DEFAULT 0,
  published_findings INT NOT NULL DEFAULT 0,
  provider        TEXT,                       -- model provider
  model_version   TEXT,
  input_tokens    INT  NOT NULL DEFAULT 0,
  output_tokens   INT  NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  latency_ms      INT  NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, review_key, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_reviews_repo ON reviews(repository_id, created_at DESC);

-- Findings ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id            UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  rule_id              TEXT NOT NULL,
  category             TEXT NOT NULL,
  severity             TEXT NOT NULL,
  source               TEXT NOT NULL,          -- builtin|ruff|eslint|semgrep|model|merged
  file_path            TEXT NOT NULL,
  start_line           INT  NOT NULL,
  end_line             INT  NOT NULL,
  problem              TEXT NOT NULL,
  impact               TEXT,
  evidence             JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_patch      TEXT,
  introduced_by_change BOOLEAN NOT NULL DEFAULT TRUE,
  verification_status  TEXT NOT NULL,          -- verified|plausible|unverified|rejected
  reported_confidence  NUMERIC(4,3),
  calibrated_confidence NUMERIC(4,3),
  analyzer_result      TEXT,
  test_result          TEXT,
  model_version        TEXT,
  published            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);
CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings(rule_id);

-- Developer feedback (labels) for calibration and regression building --------
CREATE TABLE IF NOT EXISTS finding_feedback (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id   UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,               -- useful | not_useful | false_positive | fixed
  actor        TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Semantic index (code chunks / docs) for hybrid retrieval -------------------
CREATE TABLE IF NOT EXISTS code_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  start_line    INT NOT NULL,
  end_line      INT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(1536),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chunks_repo ON code_chunks(repository_id, file_path);
-- Approximate nearest-neighbour index for vector search.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON code_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Evaluation / benchmark runs (accuracy lab) ---------------------------------
CREATE TABLE IF NOT EXISTS eval_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset        TEXT NOT NULL,
  dataset_version TEXT,
  provider       TEXT,
  model_version  TEXT,
  prompt_version TEXT,
  precision      NUMERIC(5,4),
  recall         NUMERIC(5,4),
  f1             NUMERIC(5,4),
  localization   NUMERIC(5,4),
  cost_usd       NUMERIC(12,6),
  latency_ms     INT,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
