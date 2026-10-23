-- Everything Oura and Whoop return, not just the handful of metrics the old
-- wearables backend kept.
--
-- wearables.records holds every document exactly as the provider sent it
-- (sleep sessions, daily scores, workouts, tags, ring configuration, profile,
-- ...), with version history like clinical.fhir_resources. Every numeric value
-- in them is also written to timeseries.readings (see extract/wearables/oura.ts
-- and whoop.ts) so it can be charted and compared across providers.
CREATE SCHEMA IF NOT EXISTS wearables;

CREATE TABLE IF NOT EXISTS wearables.records (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      TEXT NOT NULL,          -- 'oura' | 'whoop'
  data_type     TEXT NOT NULL,          -- the provider's own name: 'daily_sleep', 'sleep', 'workout', 'recovery', ...
  record_id     TEXT NOT NULL,          -- the provider's id for the document
  version       INT NOT NULL DEFAULT 1,
  is_current    BOOLEAN NOT NULL DEFAULT true,
  json          JSONB NOT NULL,
  content_hash  TEXT NOT NULL,
  day           DATE,                   -- the calendar day the provider assigns it to, when it has one
  start_time    TIMESTAMPTZ,
  end_time      TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wearable_records_current_uk
  ON wearables.records (provider, data_type, record_id)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS wearable_records_type_day_idx
  ON wearables.records (provider, data_type, day);
CREATE INDEX IF NOT EXISTS wearable_records_type_start_idx
  ON wearables.records (provider, data_type, start_time);

-- A qualifier for a reading: what the ring was doing for a heart-rate sample
-- ('sleep', 'workout', ...), the sport of a workout, a sleep session's type,
-- the day's stress summary, and so on.
ALTER TABLE timeseries.readings ADD COLUMN IF NOT EXISTS context TEXT;

-- Resume point per provider data type, so a newly supported type downloads
-- its full history and one failing type doesn't hold the others back.
CREATE TABLE IF NOT EXISTS ops.wearable_sync_state (
  provider        TEXT NOT NULL,
  data_type       TEXT NOT NULL,
  last_synced_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, data_type)
);

-- ============================================================
-- Convenience views over the current documents
-- ============================================================
CREATE OR REPLACE VIEW wearables.oura_sleep AS
SELECT
  record_id,
  day,
  start_time,
  end_time,
  json->>'type'                          AS sleep_type,
  (json->>'total_sleep_duration')::int   AS total_sleep_s,
  (json->>'deep_sleep_duration')::int    AS deep_s,
  (json->>'light_sleep_duration')::int   AS light_s,
  (json->>'rem_sleep_duration')::int     AS rem_s,
  (json->>'awake_time')::int             AS awake_s,
  (json->>'time_in_bed')::int            AS time_in_bed_s,
  (json->>'latency')::int                AS latency_s,
  (json->>'efficiency')::int             AS efficiency_pct,
  (json->>'average_heart_rate')::float   AS average_heart_rate,
  (json->>'lowest_heart_rate')::int      AS lowest_heart_rate,
  (json->>'average_hrv')::int            AS average_hrv_ms,
  (json->>'average_breath')::float       AS average_breath_rate,
  (json->>'restless_periods')::int       AS restless_periods,
  json->>'sleep_phase_5_min'             AS hypnogram_5_min,  -- 1 deep, 2 light, 3 REM, 4 awake
  json
FROM wearables.records
WHERE provider = 'oura' AND data_type = 'sleep' AND is_current;

CREATE OR REPLACE VIEW wearables.whoop_sleep AS
SELECT
  record_id,
  start_time,
  end_time,
  (json->>'nap')::boolean                                                       AS nap,
  json->>'score_state'                                                          AS score_state,
  (json#>>'{score,sleep_performance_percentage}')::float                        AS performance_pct,
  (json#>>'{score,sleep_efficiency_percentage}')::float                         AS efficiency_pct,
  (json#>>'{score,sleep_consistency_percentage}')::float                        AS consistency_pct,
  (json#>>'{score,respiratory_rate}')::float                                    AS respiratory_rate,
  (json#>>'{score,stage_summary,total_in_bed_time_milli}')::bigint / 1000       AS time_in_bed_s,
  (json#>>'{score,stage_summary,total_awake_time_milli}')::bigint / 1000        AS awake_s,
  (json#>>'{score,stage_summary,total_light_sleep_time_milli}')::bigint / 1000  AS light_s,
  (json#>>'{score,stage_summary,total_slow_wave_sleep_time_milli}')::bigint / 1000 AS deep_s,
  (json#>>'{score,stage_summary,total_rem_sleep_time_milli}')::bigint / 1000    AS rem_s,
  (json#>>'{score,stage_summary,sleep_cycle_count}')::int                       AS sleep_cycles,
  (json#>>'{score,stage_summary,disturbance_count}')::int                       AS disturbances,
  json
FROM wearables.records
WHERE provider = 'whoop' AND data_type = 'sleep' AND is_current;

CREATE OR REPLACE VIEW wearables.workouts AS
SELECT
  provider,
  record_id,
  start_time,
  end_time,
  CASE provider WHEN 'oura' THEN json->>'activity' ELSE json->>'sport_name' END AS activity,
  CASE provider
    WHEN 'oura' THEN (json->>'calories')::float
    ELSE (json#>>'{score,kilojoule}')::float / 4.184
  END                                                                           AS calories_kcal,
  CASE provider WHEN 'oura' THEN (json->>'distance')::float ELSE (json#>>'{score,distance_meter}')::float END AS distance_m,
  json->>'intensity'                                                            AS oura_intensity,
  (json#>>'{score,strain}')::float                                              AS whoop_strain,
  (json#>>'{score,average_heart_rate}')::int                                    AS whoop_average_heart_rate,
  (json#>>'{score,max_heart_rate}')::int                                        AS whoop_max_heart_rate,
  json
FROM wearables.records
WHERE data_type = 'workout' AND is_current;
