-- Structured tables for Condition, MedicationRequest, AllergyIntolerance and
-- Encounter, following the same pattern as 0002: current state only, keyed by
-- (source, resource_id), full history stays in clinical.fhir_resources.
--
-- FHIR dates may be partial ("2019", "2019-05"); *_text columns keep what the
-- source said, the TIMESTAMPTZ columns hold it padded to the first instant
-- (2019 -> 2019-01-01) so it still sorts and filters.

-- ============================================================
-- Condition (problem list, encounter diagnoses, history)
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.condition (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  clinical_status      TEXT,
  verification_status  TEXT,
  category_codes       TEXT[],
  patient_id           TEXT,
  encounter_id         TEXT,
  code_text            TEXT,

  onset_datetime       TIMESTAMPTZ,
  onset_text           TEXT,
  abatement_datetime   TIMESTAMPTZ,
  abatement_text       TEXT,
  recorded_date        TIMESTAMPTZ,

  UNIQUE (source, resource_id)
);
CREATE INDEX IF NOT EXISTS condition_patient_idx ON clinical.condition (patient_id);
CREATE INDEX IF NOT EXISTS condition_fhir_resource_idx ON clinical.condition (fhir_resource_id);

CREATE TABLE IF NOT EXISTS clinical.condition_coding (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  condition_id  BIGINT NOT NULL REFERENCES clinical.condition (id) ON DELETE CASCADE,
  system        TEXT,
  code          TEXT NOT NULL,
  display       TEXT
);
CREATE INDEX IF NOT EXISTS condition_coding_system_code_idx ON clinical.condition_coding (system, code);
CREATE INDEX IF NOT EXISTS condition_coding_condition_idx ON clinical.condition_coding (condition_id);

-- ============================================================
-- MedicationRequest (prescriptions / medication orders)
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.medication_request (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status            TEXT,
  intent            TEXT,
  patient_id        TEXT,
  encounter_id      TEXT,
  authored_on       TIMESTAMPTZ,
  medication_text   TEXT,
  medication_ref    TEXT,
  dosage_text       TEXT,
  requester_ref     TEXT,
  reason_text       TEXT[],

  UNIQUE (source, resource_id)
);
CREATE INDEX IF NOT EXISTS medication_request_patient_idx ON clinical.medication_request (patient_id);
CREATE INDEX IF NOT EXISTS medication_request_fhir_resource_idx ON clinical.medication_request (fhir_resource_id);

CREATE TABLE IF NOT EXISTS clinical.medication_request_coding (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  medication_request_id  BIGINT NOT NULL REFERENCES clinical.medication_request (id) ON DELETE CASCADE,
  system                 TEXT,
  code                   TEXT NOT NULL,
  display                TEXT
);
CREATE INDEX IF NOT EXISTS medication_request_coding_system_code_idx ON clinical.medication_request_coding (system, code);
CREATE INDEX IF NOT EXISTS medication_request_coding_request_idx ON clinical.medication_request_coding (medication_request_id);

-- ============================================================
-- AllergyIntolerance
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.allergy_intolerance (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  clinical_status      TEXT,
  verification_status  TEXT,
  type                 TEXT,
  categories           TEXT[],
  criticality          TEXT,
  patient_id           TEXT,
  substance_text       TEXT,
  onset_datetime       TIMESTAMPTZ,
  onset_text           TEXT,
  recorded_date        TIMESTAMPTZ,
  reactions            TEXT[],
  reaction_severities  TEXT[],

  UNIQUE (source, resource_id)
);
CREATE INDEX IF NOT EXISTS allergy_intolerance_patient_idx ON clinical.allergy_intolerance (patient_id);
CREATE INDEX IF NOT EXISTS allergy_intolerance_fhir_resource_idx ON clinical.allergy_intolerance (fhir_resource_id);

CREATE TABLE IF NOT EXISTS clinical.allergy_intolerance_coding (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  allergy_intolerance_id  BIGINT NOT NULL REFERENCES clinical.allergy_intolerance (id) ON DELETE CASCADE,
  system                  TEXT,
  code                    TEXT NOT NULL,
  display                 TEXT
);
CREATE INDEX IF NOT EXISTS allergy_intolerance_coding_system_code_idx ON clinical.allergy_intolerance_coding (system, code);
CREATE INDEX IF NOT EXISTS allergy_intolerance_coding_allergy_idx ON clinical.allergy_intolerance_coding (allergy_intolerance_id);

-- ============================================================
-- Encounter (visits, admissions, telehealth)
-- ============================================================
CREATE TABLE IF NOT EXISTS clinical.encounter (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fhir_resource_id  BIGINT NOT NULL REFERENCES clinical.fhir_resources (id),
  source            TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  transformed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  status                TEXT,
  class_code            TEXT,
  class_display         TEXT,
  type_text             TEXT[],
  patient_id            TEXT,
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  service_provider_ref  TEXT,
  service_provider_name TEXT,
  location_names        TEXT[],
  participant_refs      TEXT[],
  reason_text           TEXT[],

  UNIQUE (source, resource_id)
);
CREATE INDEX IF NOT EXISTS encounter_patient_idx ON clinical.encounter (patient_id);
CREATE INDEX IF NOT EXISTS encounter_period_start_idx ON clinical.encounter (period_start);
CREATE INDEX IF NOT EXISTS encounter_fhir_resource_idx ON clinical.encounter (fhir_resource_id);

CREATE TABLE IF NOT EXISTS clinical.encounter_type_coding (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encounter_id  BIGINT NOT NULL REFERENCES clinical.encounter (id) ON DELETE CASCADE,
  system        TEXT,
  code          TEXT NOT NULL,
  display       TEXT
);
CREATE INDEX IF NOT EXISTS encounter_type_coding_system_code_idx ON clinical.encounter_type_coding (system, code);
CREATE INDEX IF NOT EXISTS encounter_type_coding_encounter_idx ON clinical.encounter_type_coding (encounter_id);
