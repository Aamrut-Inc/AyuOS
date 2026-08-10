CREATE SCHEMA IF NOT EXISTS timeseries;

CREATE TABLE IF NOT EXISTS timeseries.readings (
  user_id         TEXT NOT NULL,
  metric_type     TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  value           DOUBLE PRECISION NOT NULL,
  unit            TEXT,
  source_provider TEXT NOT NULL,
  source_device   TEXT,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric_type, ts, source_provider)
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS readings_user_metric_ts_idx
  ON timeseries.readings (user_id, metric_type, ts);
