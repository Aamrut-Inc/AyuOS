CREATE SCHEMA IF NOT EXISTS ops;

-- One row per attempt of a background or user-triggered sync job, so the app
-- can show what last succeeded/failed and the scheduler can resume after a
-- restart without guessing.
CREATE TABLE IF NOT EXISTS ops.sync_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job         TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  detail      JSONB,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS sync_runs_job_started_idx
  ON ops.sync_runs (job, started_at DESC);
