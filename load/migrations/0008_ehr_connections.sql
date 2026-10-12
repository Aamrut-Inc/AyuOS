-- Health systems the user has connected (picked from Epic's directory).
-- `slug` is the short name stored as `source` on every record from it.
CREATE TABLE IF NOT EXISTS ops.ehr_connections (
  slug           TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  fhir_base_url  TEXT NOT NULL UNIQUE,
  sandbox        BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
