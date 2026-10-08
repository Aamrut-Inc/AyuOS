-- Files attached to FHIR records (DocumentReference.content,
-- DiagnosticReport.presentedForm), downloaded during the EHR import while the
-- access token is valid. Bytes live on disk, content-addressed by sha256.
CREATE TABLE IF NOT EXISTS clinical.fhir_attachments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT NOT NULL,
  url            TEXT NOT NULL,     -- as given, or 'inline:<sha256>' for embedded data
  title          TEXT,
  content_type   TEXT,
  sha256         TEXT,
  file_path      TEXT,
  size_bytes     BIGINT,
  error          TEXT,              -- set when the download failed; retried next import
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, resource_type, resource_id, url)
);
CREATE INDEX IF NOT EXISTS fhir_attachments_resource_idx
  ON clinical.fhir_attachments (source, resource_type, resource_id);
