CREATE SCHEMA IF NOT EXISTS clinical;

CREATE TABLE IF NOT EXISTS clinical.fhir_resources (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        TEXT NOT NULL,
  patient_id    TEXT,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  version       INT NOT NULL DEFAULT 1,
  is_current    BOOLEAN NOT NULL DEFAULT true,
  json          JSONB NOT NULL,
  content_hash  TEXT NOT NULL,
  date_low      TIMESTAMPTZ,
  date_high     TIMESTAMPTZ,
  date_sort     TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one "current" row per resource, enforced by Postgres rather than the app.
CREATE UNIQUE INDEX IF NOT EXISTS fhir_resources_current_uk
  ON clinical.fhir_resources (source, resource_type, resource_id)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS fhir_resources_type_idx
  ON clinical.fhir_resources (resource_type);

CREATE INDEX IF NOT EXISTS fhir_resources_patient_idx
  ON clinical.fhir_resources (patient_id);

-- date_low/date_high are populated later; per-resource-type extraction is still
-- an open question (ADR-0002, "deferred schema questions"). Index exists now so
-- the column doesn't need a migration later once extraction lands.
CREATE INDEX IF NOT EXISTS fhir_resources_date_idx
  ON clinical.fhir_resources (date_low, date_high);
