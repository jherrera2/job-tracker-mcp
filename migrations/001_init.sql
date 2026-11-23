-- 001_init: lookup tables + the six v1 tables from PRD 01 §4. Single user, no accounts.
-- Migration rules (see src/db/migrate.ts): name files NNN_description.sql (zero-padded, run in
-- numeric order); never put BEGIN/COMMIT in a file, because the runner wraps each file in a transaction;
-- never edit an applied file, add a new one.
-- Ids are identity columns (Postgres' equivalent of SQL Server IDENTITY).

-- ---------------------------------------------------------------------------
-- Lookup tables: fixed value lists, referenced by foreign keys (mirrored in src/db/lookups.ts;
-- a sync test keeps them identical).
-- Deliberate choice: the readable text code is the primary key (a natural key), not an integer
-- surrogate id, so a row in jobs says status = 'applied' rather than status_id = 4.
-- ---------------------------------------------------------------------------
CREATE TABLE job_statuses (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  sort_order smallint NOT NULL UNIQUE
);
INSERT INTO job_statuses (code, label, sort_order) VALUES
  ('saved', 'Saved', 1),
  ('go', 'Go', 2),
  ('skip', 'Skipped', 3),
  ('applied', 'Applied', 4),
  ('interviewing', 'Interviewing', 5),
  ('offer', 'Offer', 6),
  ('closed', 'Closed (after applying)', 7);

-- skip = passed on it before applying (can be revisited); closed = ended after applying.
-- Allowed moves between statuses are business rules in code (src/domain/job-status.ts), not a table.

CREATE TABLE source_kinds (
  code  text PRIMARY KEY,
  label text NOT NULL
);
INSERT INTO source_kinds (code, label) VALUES
  ('greenhouse', 'Greenhouse'),
  ('lever', 'Lever'),
  ('ashby', 'Ashby'),
  ('paste', 'Pasted text');

CREATE TABLE recommendations (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  sort_order smallint NOT NULL UNIQUE
);
INSERT INTO recommendations (code, label, sort_order) VALUES
  ('go', 'Go', 1),
  ('maybe', 'Maybe', 2),
  ('skip', 'Skip', 3);

-- ---------------------------------------------------------------------------
-- The six PRD §4 tables.
-- ---------------------------------------------------------------------------

-- One row per save of the master résumé; never overwritten. The highest version is the current one.
CREATE TABLE master_resume_versions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version    integer NOT NULL UNIQUE CHECK (version > 0),
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The user's top-5 criteria. Saving replaces the whole set.
CREATE TABLE criteria (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position   smallint NOT NULL UNIQUE CHECK (position BETWEEN 1 AND 5),
  label      text NOT NULL,
  detail     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per job. source_url is NULL for pasted jobs; UNIQUE still allows many NULLs in Postgres.
CREATE TABLE jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_url  text UNIQUE,
  source_kind text NOT NULL REFERENCES source_kinds (code),
  title       text,
  company     text,
  location    text,
  pay_text    text,
  description text NOT NULL,
  -- Deliberate denormalization: the current status is duplicated from the latest
  -- job_status_history row so the main "list jobs by status" query needs no join or subquery.
  -- set_status (step 7) must write jobs.status and the history row in ONE transaction (tested there).
  status      text NOT NULL DEFAULT 'saved' REFERENCES job_statuses (code),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_idx ON jobs (status);

-- Paper trail: one row per status change. There is no from_status column: the previous status
-- is the prior row for the same job, ordered by (created_at, id) — id breaks timestamp ties.
CREATE TABLE job_status_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     bigint NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  to_status  text NOT NULL REFERENCES job_statuses (code),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_status_history_job_order_idx ON job_status_history (job_id, created_at, id);

-- One row per fit-check run. The AI's full answer is kept as JSONB; the two scores are computed by code.
-- (Requirement/criteria statuses live inside result_json and are validated by Zod, not by tables.)
-- Token counts are nullable because not every provider reports them.
-- criteria_match_pct is nullable on purpose: a fit check can run before any criteria are saved,
-- and "no criteria" (NULL) is different from "meets none of them" (0).
CREATE TABLE fit_checks (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id             bigint NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  prompt_version     integer NOT NULL CHECK (prompt_version > 0),
  model              text NOT NULL,
  result_json        jsonb NOT NULL,
  jd_match_pct       numeric(5, 2) NOT NULL CHECK (jd_match_pct BETWEEN 0 AND 100),
  criteria_match_pct numeric(5, 2) CHECK (criteria_match_pct BETWEEN 0 AND 100),
  recommendation     text NOT NULL REFERENCES recommendations (code),
  latency_ms         integer NOT NULL CHECK (latency_ms >= 0),
  input_tokens       integer CHECK (input_tokens >= 0),
  output_tokens      integer CHECK (output_tokens >= 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fit_checks_job_id_created_at_idx ON fit_checks (job_id, created_at DESC);

-- One row per prompt version. Editing adds a version; reset goes back to the shipped default.
CREATE TABLE prompts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  version    integer NOT NULL CHECK (version > 0),
  text       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
