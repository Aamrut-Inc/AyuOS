-- Structured, typed tables per resource type, derived from clinical.fhir_resources.
-- Current-state only (one row per source+resource_id) — clinical.fhir_resources
-- already owns append-only version history, no need to duplicate it here.

-- ============================================================
-- Patient
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.patient (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  family_name       TEXT,
  given_names       TEXT[],
  gender            TEXT,
  birth_date        DATE,

  address_line         TEXT,
  address_city          TEXT,
  address_state         TEXT,
  address_postal_code   TEXT,
  address_country       TEXT,

  phone   TEXT[],
  email   TEXT[],

  marital_status_code     TEXT,
  marital_status_display  TEXT,

  language  TEXT,

  UNIQUE (source, resource_id)
);

CREATE INDEX IF NOT EXISTS patient_fhir_resource_idx ON clinical.patient (fhir_resource_id);
CREATE INDEX IF NOT EXISTS patient_family_name_idx ON clinical.patient (family_name);
CREATE INDEX IF NOT EXISTS patient_birth_date_idx ON clinical.patient (birth_date);

CREATE TABLE IF NOT EXISTS clinical.patient_identifier (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id  BIGINT NOT NULL REFERENCES clinical.patient (id) ON DELETE CASCADE,
  system      TEXT,
  value       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS patient_identifier_system_value_idx ON clinical.patient_identifier (system, value);
CREATE INDEX IF NOT EXISTS patient_identifier_patient_idx ON clinical.patient_identifier (patient_id);

-- ============================================================
-- Observation
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.observation (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status        TEXT,
  patient_id    TEXT,
  encounter_id  TEXT,

  performer_refs      TEXT[],
  has_member_refs     TEXT[],
  derived_from_refs   TEXT[],

  category_codes  TEXT[],

  value_text            TEXT,
  value_code             TEXT,
  value_code_system      TEXT,
  value_quantity_value    DOUBLE PRECISION,
  value_quantity_unit     TEXT,
  value_quantity_code     TEXT,

  effective_datetime  TIMESTAMPTZ,

  UNIQUE (source, resource_id)
);

CREATE INDEX IF NOT EXISTS observation_fhir_resource_idx ON clinical.observation (fhir_resource_id);
CREATE INDEX IF NOT EXISTS observation_patient_idx ON clinical.observation (patient_id);
CREATE INDEX IF NOT EXISTS observation_encounter_idx ON clinical.observation (encounter_id);
CREATE INDEX IF NOT EXISTS observation_effective_idx ON clinical.observation (effective_datetime);
CREATE INDEX IF NOT EXISTS observation_category_idx ON clinical.observation USING GIN (category_codes);
CREATE INDEX IF NOT EXISTS observation_has_member_idx ON clinical.observation USING GIN (has_member_refs);
CREATE INDEX IF NOT EXISTS observation_derived_from_idx ON clinical.observation USING GIN (derived_from_refs);

CREATE TABLE IF NOT EXISTS clinical.observation_code_coding (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id  BIGINT NOT NULL REFERENCES clinical.observation (id) ON DELETE CASCADE,
  system          TEXT,
  code            TEXT NOT NULL,
  display         TEXT
);
CREATE INDEX IF NOT EXISTS observation_code_coding_system_code_idx ON clinical.observation_code_coding (system, code);
CREATE INDEX IF NOT EXISTS observation_code_coding_observation_idx ON clinical.observation_code_coding (observation_id);

-- ============================================================
-- Immunization
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.immunization (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status               TEXT,
  patient_id           TEXT,

  occurrence_datetime  TIMESTAMPTZ,

  dose_quantity_value  DOUBLE PRECISION,
  dose_quantity_unit   TEXT,

  site_code     TEXT,
  site_system   TEXT,
  site_display  TEXT,

  route_code     TEXT,
  route_system   TEXT,
  route_display  TEXT,

  lot_number             TEXT,
  manufacturer_display   TEXT,

  performer_refs  TEXT[],

  UNIQUE (source, resource_id)
);

CREATE INDEX IF NOT EXISTS immunization_fhir_resource_idx ON clinical.immunization (fhir_resource_id);
CREATE INDEX IF NOT EXISTS immunization_patient_idx ON clinical.immunization (patient_id);
CREATE INDEX IF NOT EXISTS immunization_occurrence_idx ON clinical.immunization (occurrence_datetime);

CREATE TABLE IF NOT EXISTS clinical.immunization_vaccine_coding (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  immunization_id   BIGINT NOT NULL REFERENCES clinical.immunization (id) ON DELETE CASCADE,
  system            TEXT,
  code              TEXT NOT NULL,
  display           TEXT
);
CREATE INDEX IF NOT EXISTS immunization_vaccine_coding_system_code_idx ON clinical.immunization_vaccine_coding (system, code);
CREATE INDEX IF NOT EXISTS immunization_vaccine_coding_immunization_idx ON clinical.immunization_vaccine_coding (immunization_id);

-- ============================================================
-- DiagnosticReport
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.diagnostic_report (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status        TEXT,
  patient_id    TEXT,
  encounter_id  TEXT,

  category_codes  TEXT[],

  effective_datetime  TIMESTAMPTZ,
  issued              TIMESTAMPTZ,
  conclusion_text     TEXT,

  result_observation_ids  TEXT[],

  UNIQUE (source, resource_id)
);

CREATE INDEX IF NOT EXISTS diagnostic_report_fhir_resource_idx ON clinical.diagnostic_report (fhir_resource_id);
CREATE INDEX IF NOT EXISTS diagnostic_report_patient_idx ON clinical.diagnostic_report (patient_id);
CREATE INDEX IF NOT EXISTS diagnostic_report_encounter_idx ON clinical.diagnostic_report (encounter_id);
CREATE INDEX IF NOT EXISTS diagnostic_report_effective_idx ON clinical.diagnostic_report (effective_datetime);
CREATE INDEX IF NOT EXISTS diagnostic_report_category_idx ON clinical.diagnostic_report USING GIN (category_codes);
CREATE INDEX IF NOT EXISTS diagnostic_report_result_idx ON clinical.diagnostic_report USING GIN (result_observation_ids);

CREATE TABLE IF NOT EXISTS clinical.diagnostic_report_coding (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  diagnostic_report_id  BIGINT NOT NULL REFERENCES clinical.diagnostic_report (id) ON DELETE CASCADE,
  field                 TEXT NOT NULL CHECK (field IN ('code', 'conclusion_code')),
  system                TEXT,
  code                  TEXT NOT NULL,
  display               TEXT
);
CREATE INDEX IF NOT EXISTS diagnostic_report_coding_field_system_code_idx ON clinical.diagnostic_report_coding (field, system, code);
CREATE INDEX IF NOT EXISTS diagnostic_report_coding_report_idx ON clinical.diagnostic_report_coding (diagnostic_report_id);

CREATE TABLE IF NOT EXISTS clinical.diagnostic_report_presented_form (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  diagnostic_report_id  BIGINT NOT NULL REFERENCES clinical.diagnostic_report (id) ON DELETE CASCADE,
  content_type          TEXT,
  url                   TEXT,
  title                 TEXT
);
CREATE INDEX IF NOT EXISTS diagnostic_report_presented_form_report_idx ON clinical.diagnostic_report_presented_form (diagnostic_report_id);

-- ============================================================
-- DocumentReference
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.document_reference (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status       TEXT,
  patient_id   TEXT,

  category_codes  TEXT[],

  date           TIMESTAMPTZ,
  author_refs    TEXT[],
  encounter_ids  TEXT[],

  context_period_start  TIMESTAMPTZ,
  context_period_end    TIMESTAMPTZ,

  UNIQUE (source, resource_id)
);

CREATE INDEX IF NOT EXISTS document_reference_fhir_resource_idx ON clinical.document_reference (fhir_resource_id);
CREATE INDEX IF NOT EXISTS document_reference_patient_idx ON clinical.document_reference (patient_id);
CREATE INDEX IF NOT EXISTS document_reference_date_idx ON clinical.document_reference (date);
CREATE INDEX IF NOT EXISTS document_reference_category_idx ON clinical.document_reference USING GIN (category_codes);
CREATE INDEX IF NOT EXISTS document_reference_encounter_idx ON clinical.document_reference USING GIN (encounter_ids);

CREATE TABLE IF NOT EXISTS clinical.document_reference_type_coding (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_reference_id  BIGINT NOT NULL REFERENCES clinical.document_reference (id) ON DELETE CASCADE,
  system                 TEXT,
  code                   TEXT NOT NULL,
  display                TEXT
);
CREATE INDEX IF NOT EXISTS document_reference_type_coding_system_code_idx ON clinical.document_reference_type_coding (system, code);
CREATE INDEX IF NOT EXISTS document_reference_type_coding_doc_idx ON clinical.document_reference_type_coding (document_reference_id);

CREATE TABLE IF NOT EXISTS clinical.document_reference_content (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_reference_id  BIGINT NOT NULL REFERENCES clinical.document_reference (id) ON DELETE CASCADE,
  content_type           TEXT,
  url                    TEXT,
  title                  TEXT,
  position               INT
);
CREATE INDEX IF NOT EXISTS document_reference_content_doc_idx ON clinical.document_reference_content (document_reference_id);

-- ============================================================
-- Procedure
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.procedure (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status       TEXT,
  patient_id   TEXT,

  category_code     TEXT,
  category_system   TEXT,
  category_display  TEXT,

  performed_datetime  TIMESTAMPTZ,

  report_diagnostic_report_ids  TEXT[],
  performer_refs                 TEXT[],

  UNIQUE (source, resource_id)
);

CREATE INDEX IF NOT EXISTS procedure_fhir_resource_idx ON clinical.procedure (fhir_resource_id);
CREATE INDEX IF NOT EXISTS procedure_patient_idx ON clinical.procedure (patient_id);
CREATE INDEX IF NOT EXISTS procedure_performed_idx ON clinical.procedure (performed_datetime);
CREATE INDEX IF NOT EXISTS procedure_report_idx ON clinical.procedure USING GIN (report_diagnostic_report_ids);

CREATE TABLE IF NOT EXISTS clinical.procedure_coding (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  procedure_id  BIGINT NOT NULL REFERENCES clinical.procedure (id) ON DELETE CASCADE,
  field         TEXT NOT NULL CHECK (field IN ('code', 'reason_code')),
  system        TEXT,
  code          TEXT NOT NULL,
  display       TEXT
);
CREATE INDEX IF NOT EXISTS procedure_coding_field_system_code_idx ON clinical.procedure_coding (field, system, code);
CREATE INDEX IF NOT EXISTS procedure_coding_procedure_idx ON clinical.procedure_coding (procedure_id);
