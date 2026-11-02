-- Schema `agent`: the health agent's read layer and its own state.
--
-- Every read the agent makes goes through the views below, which apply the
-- handbook's rules (current versions only, sandbox hospitals hidden unless the
-- include_sandbox setting is on, excluded statuses removed, confirmed lab PDF
-- rows only, no personal identifiers, providers kept apart). The agent's
-- database roles (0012) can read these views and nothing in the raw schemas.
--
-- Re-run on every migrate, so everything is idempotent. Plain views are
-- dropped and recreated so definition changes apply; the materialized
-- v_wearable_daily is only rebuilt when its version tag changes.
CREATE SCHEMA IF NOT EXISTS agent;

-- Fuzzy test-name search for the lookup tools (9.1), when the role may
-- create extensions. Installed into `agent` so the read role finds it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    CREATE EXTENSION pg_trgm SCHEMA agent;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_trgm not installed: %', SQLERRM;
END $$;

-- ============================================================
-- Agent-owned tables
-- ============================================================
CREATE TABLE IF NOT EXISTS agent.user_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  source      TEXT NOT NULL DEFAULT 'app',     -- 'system' | 'user' | 'app'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One stretch of time at one UTC offset, rebuilt from the wearable documents
-- (agent/jobs/tz-history.ts). valid_to NULL = open-ended.
CREATE TABLE IF NOT EXISTS agent.tz_history (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  valid_from          TIMESTAMPTZ NOT NULL,
  valid_to            TIMESTAMPTZ,
  utc_offset_minutes  INT NOT NULL,
  iana_tz             TEXT,
  source              TEXT NOT NULL,
  observations        INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tz_history_from_idx ON agent.tz_history (valid_from);

CREATE TABLE IF NOT EXISTS agent.metric_catalog (
  metric_type       TEXT NOT NULL,
  source_provider   TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  definition        TEXT NOT NULL,
  unit_canonical    TEXT NOT NULL,
  unit_aliases      TEXT[] NOT NULL DEFAULT '{}',
  value_kind        TEXT NOT NULL CHECK (value_kind IN ('continuous_sample', 'daily_value', 'per_session', 'snapshot', 'ordinal', 'score')),
  ordinal_labels    JSONB,
  comparable_group  TEXT NOT NULL,
  day_anchor        TEXT NOT NULL CHECK (day_anchor IN ('records_day', 'local_ts', 'sync_time')),
  stored_in         TEXT NOT NULL CHECK (stored_in IN ('readings', 'records')),
  cautions          TEXT,
  PRIMARY KEY (metric_type, source_provider)
);

-- Extracted text of downloaded clinical-note files (agent/jobs/notes.ts).
-- Full text stays on the Mac; it is redacted only when placed in a prompt.
CREATE TABLE IF NOT EXISTS agent.note_text (
  attachment_id  BIGINT PRIMARY KEY,
  text           TEXT,
  method         TEXT NOT NULL,   -- 'html' | 'rtf' | 'xml' | 'pdf' | 'text' | 'unsupported' | 'failed'
  char_count     INT NOT NULL DEFAULT 0,
  extracted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  error          TEXT
);

CREATE TABLE IF NOT EXISTS agent.note_chunks (
  attachment_id  BIGINT NOT NULL REFERENCES agent.note_text(attachment_id) ON DELETE CASCADE,
  chunk_no       INT NOT NULL,
  text           TEXT NOT NULL,
  tsv            TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY (attachment_id, chunk_no)
);
CREATE INDEX IF NOT EXISTS note_chunks_tsv_idx ON agent.note_chunks USING GIN (tsv);

CREATE TABLE IF NOT EXISTS agent.conversations (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  title       TEXT,
  summary     TEXT              -- rolling summary of turns older than the last 6
);

CREATE TABLE IF NOT EXISTS agent.turns (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES agent.conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text             TEXT NOT NULL,
  lane             TEXT,
  route            JSONB,
  plan             JSONB,
  evidence         JSONB,
  verifier         JSONB,
  pending          JSONB,       -- the task a clarifying question is waiting on
  status           TEXT CHECK (status IN ('answered', 'clarifying', 'declined', 'failed', 'cancelled', 'urgent')),
  latency_ms       INT,
  tokens           INT,
  cost             NUMERIC(10, 5),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turns_conversation_idx ON agent.turns (conversation_id, id);

CREATE TABLE IF NOT EXISTS agent.tool_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id      BIGINT REFERENCES agent.turns(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'sql', 'python', 'search', 'fetch', 'redaction', 'safety')),
  name         TEXT NOT NULL,
  input        JSONB,
  output       JSONB,
  evidence_id  TEXT UNIQUE,
  status       TEXT NOT NULL,
  error        TEXT,
  latency_ms   INT,
  tokens_in    INT,
  tokens_out   INT,
  cost_usd     NUMERIC(10, 5),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_runs_turn_idx ON agent.tool_runs (turn_id);
CREATE INDEX IF NOT EXISTS tool_runs_created_idx ON agent.tool_runs (created_at);

CREATE TABLE IF NOT EXISTS agent.feedback (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id     BIGINT NOT NULL REFERENCES agent.turns(id) ON DELETE CASCADE,
  rating      TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent.memory_facts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fact_text       TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('goal', 'preference', 'context', 'symptom_history', 'device')),
  source_turn_id  BIGINT REFERENCES agent.turns(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS agent.example_library (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question        TEXT NOT NULL,
  route           JSONB NOT NULL,
  plan            JSONB NOT NULL,
  program         JSONB NOT NULL,       -- {queries: [{name, sql}], python}; parameters, never results
  result_shape    JSONB NOT NULL,       -- keys and types only, never values
  verified_by     TEXT NOT NULL CHECK (verified_by IN ('seed', 'eval', 'user_feedback')),
  schema_version  TEXT NOT NULL,
  domains         TEXT[] NOT NULL DEFAULT '{}',
  metrics         TEXT[] NOT NULL DEFAULT '{}',
  uses            INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  UNIQUE (question, verified_by)
);

-- ============================================================
-- Settings and time functions
-- ============================================================
CREATE OR REPLACE FUNCTION agent.include_sandbox() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::boolean FROM agent.user_settings WHERE key = 'include_sandbox'), false)
$$;

-- The person's current IANA zone: the user's choice, else the Mac's (5.1).
CREATE OR REPLACE FUNCTION agent.current_tz() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value #>> '{}' FROM agent.user_settings WHERE key = 'timezone'), 'UTC')
$$;

-- The instant in the person's local wall-clock time, from the offset history
-- (5.2), falling back to the current zone when no history covers it.
CREATE OR REPLACE FUNCTION agent.local_ts(ts timestamptz) RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT CASE WHEN h.iana_tz IS NOT NULL THEN ts AT TIME ZONE h.iana_tz
                 ELSE (ts AT TIME ZONE 'UTC') + make_interval(mins => h.utc_offset_minutes) END
     FROM agent.tz_history h
     WHERE h.valid_from <= ts AND (h.valid_to IS NULL OR ts < h.valid_to)
     ORDER BY h.valid_from DESC LIMIT 1),
    ts AT TIME ZONE agent.current_tz())
$$;

CREATE OR REPLACE FUNCTION agent.local_day(ts timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$ SELECT agent.local_ts(ts)::date $$;

-- ============================================================
-- Small helpers for reading raw FHIR JSON safely
-- ============================================================
CREATE OR REPLACE FUNCTION agent._num(t text) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?\s*$' THEN t::double precision END
$$;

-- Precision of a FHIR date/dateTime string as written.
CREATE OR REPLACE FUNCTION agent._precision(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IS NULL THEN NULL
    WHEN t ~ '^\d{4}$' THEN 'year'
    WHEN t ~ '^\d{4}-\d{2}$' THEN 'month'
    WHEN t ~ '^\d{4}-\d{2}-\d{2}$' THEN 'date'
    WHEN t ~ '^\d{4}-\d{2}-\d{2}T' THEN 'instant'
  END
$$;

-- A FHIR date/dateTime as an instant (partial dates padded, date-only pinned
-- to UTC midnight, like transform/fhir-helpers.ts fhirInstant).
CREATE OR REPLACE FUNCTION agent._instant(t text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE agent._precision(t)
    WHEN 'year' THEN (t || '-01-01T00:00:00Z')::timestamptz
    WHEN 'month' THEN (t || '-01T00:00:00Z')::timestamptz
    WHEN 'date' THEN (t || 'T00:00:00Z')::timestamptz
    WHEN 'instant' THEN t::timestamptz
  END
$$;

-- The calendar date a FHIR value belongs to: date-only and partial values as
-- written (never converted, which would shift the day west of UTC); instants
-- as the local day in the person's current zone (5.3).
CREATE OR REPLACE FUNCTION agent._calendar_date(t text, fallback timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT CASE agent._precision(t)
    WHEN 'year' THEN (t || '-01-01')::date
    WHEN 'month' THEN (t || '-01')::date
    WHEN 'date' THEN t::date
    WHEN 'instant' THEN (t::timestamptz AT TIME ZONE agent.current_tz())::date
    ELSE (fallback AT TIME ZONE agent.current_tz())::date
  END
$$;

-- Hospital interpretation code -> H, L, A, N (lab's own flag).
CREATE OR REPLACE FUNCTION agent._flag(code text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN code IS NULL THEN NULL
    WHEN upper(code) IN ('H', 'HH', 'HU', '>', 'HX') THEN 'H'
    WHEN upper(code) IN ('L', 'LL', 'LU', '<', 'LX') THEN 'L'
    WHEN upper(code) IN ('N', 'NEG', 'NORMAL') THEN 'N'
    ELSE 'A'
  END
$$;

-- Whether a hospital source may be shown: real hospitals always; sandbox
-- (Epic test patients) only when include_sandbox is on. Sources without a
-- connection row (the command-line Apple Health importer) are real.
-- SECURITY DEFINER because ops.* is not readable by the agent roles.
CREATE OR REPLACE FUNCTION agent.source_allowed(src text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, agent AS $$
  SELECT agent.include_sandbox()
      OR NOT coalesce((SELECT c.sandbox FROM ops.ehr_connections c WHERE c.slug = src), false)
$$;

-- ============================================================
-- Hospital views
-- ============================================================
DROP VIEW IF EXISTS agent._obs_values CASCADE;
DROP VIEW IF EXISTS agent.v_profile CASCADE;
DROP VIEW IF EXISTS agent.v_lab_results CASCADE;
DROP VIEW IF EXISTS agent.v_vitals CASCADE;
DROP VIEW IF EXISTS agent.v_conditions CASCADE;
DROP VIEW IF EXISTS agent.v_prescriptions CASCADE;
DROP VIEW IF EXISTS agent.v_allergies CASCADE;
DROP VIEW IF EXISTS agent.v_immunizations CASCADE;
DROP VIEW IF EXISTS agent.v_procedures CASCADE;
DROP VIEW IF EXISTS agent.v_encounters CASCADE;
DROP VIEW IF EXISTS agent.v_reports CASCADE;
DROP VIEW IF EXISTS agent.v_documents CASCADE;
DROP VIEW IF EXISTS agent.v_note_text CASCADE;
DROP VIEW IF EXISTS agent.v_note_chunks CASCADE;
DROP VIEW IF EXISTS agent.v_fhir_other CASCADE;
DROP VIEW IF EXISTS agent.v_medication_statements CASCADE;
DROP VIEW IF EXISTS agent.v_family_history CASCADE;
DROP VIEW IF EXISTS agent.v_sleep_nights CASCADE;
DROP VIEW IF EXISTS agent.v_sleep_sessions CASCADE;
DROP VIEW IF EXISTS agent.v_recovery_daily CASCADE;
DROP VIEW IF EXISTS agent.v_workouts CASCADE;
DROP VIEW IF EXISTS agent.v_readings CASCADE;
DROP VIEW IF EXISTS agent.v_data_freshness CASCADE;
DROP VIEW IF EXISTS agent.v_metric_catalog CASCADE;

-- One value row per current observation: the typed value, else the raw JSON
-- value (valueString, valueQuantity...), else one row per `component` (blood
-- pressure); reference range and interpretation from the raw JSON (T10).
CREATE VIEW agent._obs_values AS
SELECT
  o.id                                                     AS obs_id,
  o.source,
  o.resource_id,
  c.ord::int                                               AS comp_index,
  o.category_codes,
  lower(o.status)                                          AS status,
  coalesce(c.loinc, pl.code)                               AS loinc_code,
  coalesce(c.name, f.json #>> '{code,text}', pl.display, anyc.display) AS name,
  CASE WHEN c.comp IS NULL THEN coalesce(o.value_quantity_value, agent._num(f.json #>> '{valueQuantity,value}'),
                                         agent._num(f.json ->> 'valueInteger'))
       ELSE agent._num(c.comp #>> '{valueQuantity,value}') END AS value_num,
  CASE WHEN c.comp IS NULL THEN coalesce(o.value_text, f.json ->> 'valueString', f.json #>> '{valueCodeableConcept,text}',
                                         o.value_code, f.json ->> 'valueBoolean')
       ELSE coalesce(c.comp ->> 'valueString', c.comp #>> '{valueCodeableConcept,text}',
                     c.comp #>> '{valueCodeableConcept,coding,0,display}') END AS value_text,
  coalesce(c.comp, f.json) #>> '{valueQuantity,comparator}' AS comparator,
  CASE WHEN c.comp IS NULL THEN coalesce(o.value_quantity_unit, f.json #>> '{valueQuantity,unit}', f.json #>> '{valueQuantity,code}')
       ELSE coalesce(c.comp #>> '{valueQuantity,unit}', c.comp #>> '{valueQuantity,code}') END AS unit,
  agent._num(coalesce(c.comp, f.json) #>> '{referenceRange,0,low,value}')  AS ref_low,
  agent._num(coalesce(c.comp, f.json) #>> '{referenceRange,0,high,value}') AS ref_high,
  coalesce(c.comp, f.json) #>> '{referenceRange,0,text}'   AS ref_text,
  coalesce(coalesce(c.comp, f.json) #>> '{interpretation,0,coding,0,code}',
           f.json #>> '{interpretation,0,coding,0,code}') AS interp_code,
  coalesce(f.json ->> 'effectiveDateTime', f.json #>> '{effectivePeriod,start}', f.json ->> 'effectiveInstant', f.json ->> 'issued') AS effective_str,
  coalesce(o.effective_datetime,
           agent._instant(coalesce(f.json ->> 'effectiveDateTime', f.json #>> '{effectivePeriod,start}', f.json ->> 'effectiveInstant', f.json ->> 'issued'))) AS effective_at,
  o.encounter_id,
  coalesce(cardinality(o.has_member_refs), 0) > 0          AS has_members,
  (f.json ? 'component')                                   AS has_components
FROM clinical.observation o
JOIN clinical.fhir_resources f ON f.id = o.fhir_resource_id
LEFT JOIN LATERAL (
  SELECT cc.code, cc.display FROM clinical.observation_code_coding cc
  WHERE cc.observation_id = o.id AND cc.system = 'http://loinc.org'
  ORDER BY (cc.code IN ('8867-4', '8480-6', '8462-4', '8310-5', '29463-7', '3141-9', '8302-2', '9279-1', '2708-6', '59408-5', '39156-5', '85354-9', '55284-4')) DESC, cc.id
  LIMIT 1
) pl ON true
LEFT JOIN LATERAL (
  SELECT cc.display FROM clinical.observation_code_coding cc
  WHERE cc.observation_id = o.id AND cc.display IS NOT NULL ORDER BY cc.id LIMIT 1
) anyc ON true
LEFT JOIN LATERAL (
  SELECT e.comp, e.ord,
         (SELECT x ->> 'code' FROM jsonb_array_elements(e.comp #> '{code,coding}') x WHERE x ->> 'system' = 'http://loinc.org' LIMIT 1) AS loinc,
         coalesce(e.comp #>> '{code,text}', e.comp #>> '{code,coding,0,display}') AS name
  FROM jsonb_array_elements(
         CASE WHEN o.value_quantity_value IS NULL AND o.value_text IS NULL AND o.value_code IS NULL
                   AND NOT (f.json ?| ARRAY['valueQuantity', 'valueString', 'valueCodeableConcept', 'valueInteger', 'valueBoolean'])
                   AND jsonb_typeof(f.json -> 'component') = 'array'
              THEN f.json -> 'component' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(comp, ord)
) c ON true
WHERE f.is_current
  AND agent.source_allowed(o.source)
  AND coalesce(lower(o.status), '') NOT IN ('entered-in-error', 'cancelled');

CREATE VIEW agent.v_profile AS
WITH p AS (
  SELECT p.gender, p.birth_date
  FROM clinical.patient p
  JOIN clinical.fhir_resources f ON f.id = p.fhir_resource_id AND f.is_current
  WHERE agent.source_allowed(p.source)
  ORDER BY p.transformed_at DESC
  LIMIT 1
),
hospitals AS (
  SELECT jsonb_agg(jsonb_build_object(
           'source', c.slug, 'name', c.display_name, 'sandbox', c.sandbox,
           'last_import', (SELECT max(s.finished_at) FROM ops.sync_runs s
                           WHERE s.job = 'ehr-import:' || c.slug AND s.status = 'success'))
         ORDER BY c.slug) AS list
  FROM ops.ehr_connections c
  WHERE agent.source_allowed(c.slug)
)
SELECT
  (SELECT date_part('year', age(current_date, p.birth_date))::int FROM p) AS age_years,
  (SELECT p.gender FROM p)                                                AS recorded_sex,
  coalesce((SELECT list FROM hospitals), '[]'::jsonb)                     AS hospitals,
  (SELECT count(*) FROM ops.ehr_connections c WHERE c.sandbox)::int       AS sandbox_hospitals_hidden_or_shown;

CREATE VIEW agent.v_lab_results AS
WITH hospital AS (
  SELECT
    'obs:' || v.source || ':' || v.resource_id || coalesce('#' || v.comp_index, '') AS result_key,
    'hospital'::text                  AS origin,
    v.source,
    v.loinc_code,
    v.name                            AS test_name,
    NULL::text                        AS analyte_key,
    v.value_num,
    v.value_text,
    v.comparator,
    v.unit,
    v.ref_low,
    v.ref_high,
    v.ref_text,
    agent._flag(v.interp_code)        AS flag,
    upper(coalesce(v.interp_code, '')) IN ('HH', 'LL', 'AA') AS critical,
    v.effective_at,
    agent._calendar_date(v.effective_str, v.effective_at) AS effective_date,
    coalesce(agent._precision(v.effective_str), 'instant') AS effective_precision,
    (SELECT 'rep:' || d.source || ':' || d.resource_id FROM clinical.diagnostic_report d
     WHERE d.source = v.source AND v.resource_id = ANY (d.result_observation_ids) LIMIT 1) AS report_key,
    NULL::bigint                      AS document_id,
    CASE WHEN v.loinc_code IS NOT NULL THEN 'coded' ELSE 'none' END AS code_confidence
  FROM agent._obs_values v
  WHERE EXISTS (SELECT 1 FROM unnest(v.category_codes) cat WHERE lower(cat) IN ('laboratory', 'lab'))
    -- A panel that only groups its members is not a result of its own (T20).
    AND NOT (v.has_members AND v.value_num IS NULL AND v.value_text IS NULL)
),
pdf AS (
  SELECT
    'pdf:' || r.id                    AS result_key,
    'pdf'::text                       AS origin,
    'lab_pdf'::text                   AS source,
    r.loinc_code,
    r.analyte_name                    AS test_name,
    r.analyte_key,
    r.value_num,
    r.value_text,
    r.comparator,
    r.unit,
    r.ref_low,
    r.ref_high,
    r.ref_text,
    r.flag,
    false                             AS critical,
    (coalesce(d.collected_date, r.collected_date)::text || 'T00:00:00Z')::timestamptz AS effective_at,
    coalesce(d.collected_date, r.collected_date) AS effective_date,
    'document_date'::text             AS effective_precision,
    NULL::text                        AS report_key,
    r.document_id,
    CASE WHEN r.loinc_code IS NOT NULL THEN 'suggested' ELSE 'none' END AS code_confidence
  FROM labs.results r
  JOIN labs.documents d ON d.id = r.document_id
  WHERE r.status = 'confirmed'
)
SELECT h.*, NULL::text AS possible_duplicate_of FROM hospital h
UNION ALL
SELECT p.*,
  (SELECT h.result_key FROM hospital h
   WHERE h.loinc_code = p.loinc_code AND h.effective_date = p.effective_date
     AND p.value_num IS NOT NULL AND h.value_num IS NOT NULL
     AND abs(h.value_num - p.value_num) <= 0.01 * greatest(abs(h.value_num), abs(p.value_num))
   LIMIT 1) AS possible_duplicate_of
FROM pdf p;

CREATE VIEW agent.v_vitals AS
SELECT
  'obs:' || v.source || ':' || v.resource_id || coalesce('#' || v.comp_index, '') AS result_key,
  v.source,
  CASE v.loinc_code
    WHEN '8867-4' THEN 'heart_rate'
    WHEN '8480-6' THEN 'systolic_bp'
    WHEN '8462-4' THEN 'diastolic_bp'
    WHEN '8310-5' THEN 'body_temperature'
    WHEN '29463-7' THEN 'body_weight'
    WHEN '3141-9' THEN 'body_weight'
    WHEN '8302-2' THEN 'body_height'
    WHEN '9279-1' THEN 'respiratory_rate'
    WHEN '2708-6' THEN 'oxygen_saturation'
    WHEN '59408-5' THEN 'oxygen_saturation'
    WHEN '39156-5' THEN 'bmi'
    ELSE 'other'
  END                                AS vital,
  v.loinc_code,
  v.name,
  v.value_num,
  v.value_text,
  v.unit,
  v.ref_low,
  v.ref_high,
  agent._flag(v.interp_code)         AS flag,
  upper(coalesce(v.interp_code, '')) IN ('HH', 'LL', 'AA') AS critical,
  v.effective_at,
  agent._calendar_date(v.effective_str, v.effective_at) AS effective_date,
  coalesce(agent._precision(v.effective_str), 'instant') AS effective_precision,
  v.comp_index IS NOT NULL           AS from_component
FROM agent._obs_values v
WHERE EXISTS (SELECT 1 FROM unnest(v.category_codes) cat WHERE lower(cat) IN ('vital-signs', 'vital signs', 'vitals', 'vitalsigns'))
  AND (v.value_num IS NOT NULL OR v.value_text IS NOT NULL);

CREATE VIEW agent.v_conditions AS
SELECT
  'cond:' || c.source || ':' || c.resource_id AS condition_key,
  c.source,
  c.code_text                      AS name,
  lower(c.clinical_status)         AS clinical_status,
  lower(c.verification_status)     AS verification_status,
  c.category_codes,
  coalesce(c.onset_text, f.json ->> 'onsetDateTime', f.json #>> '{onsetPeriod,start}') AS onset_text,
  c.onset_datetime,
  agent._precision(coalesce(f.json ->> 'onsetDateTime', f.json #>> '{onsetPeriod,start}')) AS onset_precision,
  coalesce(c.abatement_text, f.json ->> 'abatementDateTime') AS abatement_text,
  c.abatement_datetime,
  c.recorded_date,
  (SELECT array_agg(cc.code ORDER BY cc.id) FROM clinical.condition_coding cc
   WHERE cc.condition_id = c.id AND cc.system LIKE '%icd-10%') AS icd10_codes,
  (SELECT array_agg(cc.code ORDER BY cc.id) FROM clinical.condition_coding cc
   WHERE cc.condition_id = c.id AND cc.system = 'http://snomed.info/sct') AS snomed_codes
FROM clinical.condition c
JOIN clinical.fhir_resources f ON f.id = c.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(c.source)
  AND coalesce(lower(c.verification_status), '') NOT IN ('entered-in-error', 'refuted');

CREATE VIEW agent.v_prescriptions AS
SELECT
  'rx:' || m.source || ':' || m.resource_id AS prescription_key,
  m.source,
  m.medication_text                 AS medication,
  lower(m.status)                   AS status,
  m.intent,
  m.authored_on,
  agent._calendar_date(f.json ->> 'authoredOn', m.authored_on) AS authored_date,
  m.dosage_text,
  m.reason_text,
  (SELECT array_agg(cc.code ORDER BY cc.id) FROM clinical.medication_request_coding cc
   WHERE cc.medication_request_id = m.id AND cc.system LIKE '%rxnorm%') AS rxnorm_codes,
  'prescribed, not confirmed as taken'::text AS meaning
FROM clinical.medication_request m
JOIN clinical.fhir_resources f ON f.id = m.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(m.source)
  AND coalesce(lower(m.status), '') NOT IN ('entered-in-error', 'cancelled');

CREATE VIEW agent.v_allergies AS
SELECT
  'allergy:' || a.source || ':' || a.resource_id AS allergy_key,
  a.source,
  a.substance_text                  AS substance,
  lower(a.clinical_status)          AS clinical_status,
  lower(a.verification_status)      AS verification_status,
  a.type,
  a.categories,
  a.criticality,
  a.reactions,
  a.reaction_severities,
  a.onset_text,
  a.recorded_date
FROM clinical.allergy_intolerance a
JOIN clinical.fhir_resources f ON f.id = a.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(a.source)
  AND coalesce(lower(a.verification_status), '') NOT IN ('entered-in-error', 'refuted');

CREATE VIEW agent.v_immunizations AS
SELECT
  'imm:' || i.source || ':' || i.resource_id AS immunization_key,
  i.source,
  coalesce(f.json #>> '{vaccineCode,text}',
           (SELECT vc.display FROM clinical.immunization_vaccine_coding vc WHERE vc.immunization_id = i.id AND vc.display IS NOT NULL ORDER BY vc.id LIMIT 1)) AS vaccine,
  lower(i.status)                   AS status,
  coalesce(i.occurrence_datetime, agent._instant(f.json ->> 'occurrenceDateTime')) AS occurred_at,
  agent._calendar_date(f.json ->> 'occurrenceDateTime', i.occurrence_datetime) AS occurred_date,
  agent._precision(f.json ->> 'occurrenceDateTime') AS occurred_precision,
  i.dose_quantity_value,
  i.dose_quantity_unit,
  i.site_display,
  i.route_display,
  i.manufacturer_display
FROM clinical.immunization i
JOIN clinical.fhir_resources f ON f.id = i.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(i.source)
  AND coalesce(lower(i.status), '') NOT IN ('entered-in-error', 'cancelled', 'not-done');

CREATE VIEW agent.v_procedures AS
SELECT
  'proc:' || p.source || ':' || p.resource_id AS procedure_key,
  p.source,
  coalesce(f.json #>> '{code,text}',
           (SELECT pc.display FROM clinical.procedure_coding pc WHERE pc.procedure_id = p.id AND pc.field = 'code' AND pc.display IS NOT NULL ORDER BY pc.id LIMIT 1)) AS name,
  lower(p.status)                   AS status,
  p.category_display                AS category,
  coalesce(p.performed_datetime, agent._instant(coalesce(f.json ->> 'performedDateTime', f.json #>> '{performedPeriod,start}'))) AS performed_at,
  agent._calendar_date(coalesce(f.json ->> 'performedDateTime', f.json #>> '{performedPeriod,start}'), p.performed_datetime) AS performed_date,
  agent._precision(coalesce(f.json ->> 'performedDateTime', f.json #>> '{performedPeriod,start}')) AS performed_precision,
  f.json ->> 'performedString'      AS performed_text,
  (SELECT array_agg(pc.display ORDER BY pc.id) FROM clinical.procedure_coding pc WHERE pc.procedure_id = p.id AND pc.field = 'reason_code') AS reasons
FROM clinical.procedure p
JOIN clinical.fhir_resources f ON f.id = p.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(p.source)
  AND coalesce(lower(p.status), '') NOT IN ('entered-in-error', 'cancelled', 'not-done');

CREATE VIEW agent.v_encounters AS
SELECT
  'enc:' || e.source || ':' || e.resource_id AS encounter_key,
  e.source,
  lower(e.status)                   AS status,
  e.class_display                   AS class,
  e.type_text                       AS types,
  e.period_start,
  e.period_end,
  agent._calendar_date(f.json #>> '{period,start}', e.period_start) AS start_date,
  e.service_provider_name           AS facility,
  e.location_names,
  e.reason_text                     AS reasons
FROM clinical.encounter e
JOIN clinical.fhir_resources f ON f.id = e.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(e.source)
  AND coalesce(lower(e.status), '') NOT IN ('entered-in-error', 'cancelled');

-- Linked results keep one entry per link: the resolved result_key, or NULL
-- when the linked observation isn't in the database (T11, never dropped).
CREATE VIEW agent.v_reports AS
SELECT
  'rep:' || d.source || ':' || d.resource_id AS report_key,
  d.source,
  coalesce(f.json #>> '{code,text}',
           (SELECT dc.display FROM clinical.diagnostic_report_coding dc WHERE dc.diagnostic_report_id = d.id AND dc.field = 'code' AND dc.display IS NOT NULL ORDER BY dc.id LIMIT 1)) AS name,
  lower(d.status)                   AS status,
  d.category_codes,
  d.effective_datetime              AS effective_at,
  agent._calendar_date(f.json ->> 'effectiveDateTime', d.effective_datetime) AS effective_date,
  d.issued,
  d.conclusion_text,
  coalesce(d.result_observation_ids, '{}') AS result_observation_ids,
  ARRAY(
    SELECT CASE WHEN o.id IS NOT NULL THEN 'obs:' || d.source || ':' || rid END
    FROM unnest(coalesce(d.result_observation_ids, '{}')) WITH ORDINALITY AS u(rid, n)
    LEFT JOIN clinical.observation o ON o.source = d.source AND o.resource_id = u.rid
    ORDER BY u.n
  )                                 AS result_keys
FROM clinical.diagnostic_report d
JOIN clinical.fhir_resources f ON f.id = d.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(d.source)
  AND coalesce(lower(d.status), '') NOT IN ('entered-in-error', 'cancelled');

CREATE VIEW agent.v_documents AS
SELECT
  'doc:' || d.source || ':' || d.resource_id AS document_key,
  d.source,
  lower(d.status)                   AS status,
  coalesce(f.json #>> '{type,text}',
           (SELECT tc.display FROM clinical.document_reference_type_coding tc WHERE tc.document_reference_id = d.id AND tc.display IS NOT NULL ORDER BY tc.id LIMIT 1)) AS type,
  d.category_codes,
  d.date,
  agent._calendar_date(f.json ->> 'date', d.date) AS doc_date,
  d.context_period_start,
  d.encounter_ids,
  (SELECT array_agg(a.id ORDER BY a.id) FROM clinical.fhir_attachments a
   WHERE a.source = d.source AND a.resource_type = 'DocumentReference' AND a.resource_id = d.resource_id) AS attachment_ids,
  (SELECT string_agg(DISTINCT a.content_type, ', ') FROM clinical.fhir_attachments a
   WHERE a.source = d.source AND a.resource_type = 'DocumentReference' AND a.resource_id = d.resource_id) AS content_types,
  EXISTS (SELECT 1 FROM clinical.fhir_attachments a JOIN agent.note_text t ON t.attachment_id = a.id
          WHERE a.source = d.source AND a.resource_type = 'DocumentReference' AND a.resource_id = d.resource_id
            AND t.char_count > 0) AS has_text
FROM clinical.document_reference d
JOIN clinical.fhir_resources f ON f.id = d.fhir_resource_id AND f.is_current
WHERE agent.source_allowed(d.source)
  AND coalesce(lower(d.status), '') NOT IN ('entered-in-error');

CREATE VIEW agent.v_note_text AS
SELECT
  'doc:' || a.source || ':' || a.resource_id AS document_key,
  t.attachment_id,
  a.title,
  a.content_type,
  t.method,
  t.char_count,
  t.text,
  t.error
FROM agent.note_text t
JOIN clinical.fhir_attachments a ON a.id = t.attachment_id
WHERE agent.source_allowed(a.source)
  AND EXISTS (SELECT 1 FROM clinical.fhir_resources f
              WHERE f.source = a.source AND f.resource_type = a.resource_type AND f.resource_id = a.resource_id
                AND f.is_current AND coalesce(lower(f.json ->> 'status'), '') <> 'entered-in-error');

CREATE VIEW agent.v_note_chunks AS
SELECT n.document_key, c.attachment_id, c.chunk_no, c.text, c.tsv
FROM agent.note_chunks c
JOIN agent.v_note_text n ON n.attachment_id = c.attachment_id;

-- JSON-only record types (section 14.2). Never Patient.
CREATE VIEW agent.v_fhir_other AS
SELECT
  f.resource_type,
  lower(f.resource_type) || ':' || f.source || ':' || f.resource_id AS record_key,
  f.source,
  lower(f.json ->> 'status')       AS status,
  agent._instant(coalesce(f.json ->> 'effectiveDateTime', f.json #>> '{effectivePeriod,start}', f.json ->> 'authoredOn',
                          f.json ->> 'recordedDate', f.json ->> 'date', f.json #>> '{period,start}', f.json ->> 'startDate')) AS effective_at,
  coalesce(f.json #>> '{code,text}', f.json #>> '{code,coding,0,display}', f.json #>> '{description,text}',
           f.json ->> 'description', f.json ->> 'title', f.json #>> '{medicationCodeableConcept,text}',
           f.json #>> '{medicationReference,display}', f.json #>> '{type,0,text}', f.json #>> '{category,0,text}',
           f.json ->> 'name') AS summary_text,
  -- The person's name often rides along as subject/patient display text.
  f.json - 'subject' - 'patient' - 'contained' - 'text' AS json
FROM clinical.fhir_resources f
WHERE f.is_current
  AND f.resource_type IN ('CarePlan', 'CareTeam', 'Device', 'FamilyMemberHistory', 'Goal', 'MedicationStatement',
                          'QuestionnaireResponse', 'ServiceRequest', 'Specimen')
  AND agent.source_allowed(f.source)
  AND coalesce(lower(f.json ->> 'status'), '') NOT IN ('entered-in-error', 'cancelled');

CREATE VIEW agent.v_medication_statements AS
SELECT
  'medstmt:' || f.source || ':' || f.resource_id AS statement_key,
  f.source,
  coalesce(f.json #>> '{medicationCodeableConcept,text}', f.json #>> '{medicationCodeableConcept,coding,0,display}',
           f.json #>> '{medicationReference,display}') AS medication,
  lower(f.json ->> 'status')       AS status,
  lower(f.json ->> 'status') = 'not-taken' AS not_taken,
  agent._instant(coalesce(f.json ->> 'effectiveDateTime', f.json #>> '{effectivePeriod,start}')) AS effective_start,
  agent._instant(f.json #>> '{effectivePeriod,end}') AS effective_end,
  f.json #>> '{dosage,0,text}'      AS dosage_text,
  agent._instant(f.json ->> 'dateAsserted') AS asserted_at
FROM clinical.fhir_resources f
WHERE f.is_current AND f.resource_type = 'MedicationStatement'
  AND agent.source_allowed(f.source)
  AND coalesce(lower(f.json ->> 'status'), '') <> 'entered-in-error';

CREATE VIEW agent.v_family_history AS
SELECT
  'fmh:' || f.source || ':' || f.resource_id || '#' || c.n AS family_history_key,
  f.source,
  coalesce(f.json #>> '{relationship,text}', f.json #>> '{relationship,coding,0,display}', f.json #>> '{relationship,coding,0,code}') AS relationship,
  coalesce(c.cond #>> '{code,text}', c.cond #>> '{code,coding,0,display}') AS condition,
  coalesce(agent._num(c.cond #>> '{onsetAge,value}'), agent._num(c.cond #>> '{onsetRange,low,value}')) AS onset_age,
  c.cond ->> 'onsetString'          AS onset_text,
  lower(f.json ->> 'status')       AS status
FROM clinical.fhir_resources f
LEFT JOIN LATERAL jsonb_array_elements(coalesce(f.json -> 'condition', '[null]'::jsonb)) WITH ORDINALITY AS c(cond, n) ON true
WHERE f.is_current AND f.resource_type = 'FamilyMemberHistory'
  AND agent.source_allowed(f.source)
  AND coalesce(lower(f.json ->> 'status'), '') <> 'entered-in-error';

-- ============================================================
-- Wearable views (providers kept separate)
-- ============================================================

-- Offset written in an ISO string ("...-07:00" or "Z"), in minutes.
CREATE OR REPLACE FUNCTION agent._iso_offset_minutes(t text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t ~ 'Z$' THEN 0
    WHEN t ~ '[+-]\d{2}:\d{2}$' THEN (extract(epoch FROM substring(t FROM '([+-]\d{2}:\d{2})$')::interval) / 60)::int
  END
$$;

CREATE OR REPLACE FUNCTION agent._offset_minutes(t text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^[+-]\d{2}:\d{2}$' THEN (extract(epoch FROM t::interval) / 60)::int END
$$;

-- Each sleep period, naps included. Day = the provider's day label: Oura's
-- `day` (the day the person woke up); Whoop has none, so the local date of
-- the wake-up time is used, which matches Oura's convention.
CREATE VIEW agent.v_sleep_sessions AS
SELECT
  'oura'::text                      AS provider,
  'oura:sleep:' || r.record_id      AS session_key,
  r.day,
  r.start_time                      AS start_utc,
  r.end_time                        AS end_utc,
  coalesce((r.json ->> 'bedtime_start')::timestamp, agent.local_ts(r.start_time)) AS start_local,
  coalesce((r.json ->> 'bedtime_end')::timestamp, agent.local_ts(r.end_time))     AS end_local,
  agent._iso_offset_minutes(r.json ->> 'bedtime_start') AS utc_offset_minutes,
  r.json ->> 'type'                 AS sleep_type,
  (r.json ->> 'type') = 'long_sleep' AS is_main,
  'SCORED'::text                    AS score_state,
  agent._num(r.json ->> 'total_sleep_duration') AS total_sleep_s,
  agent._num(r.json ->> 'deep_sleep_duration')  AS deep_s,
  agent._num(r.json ->> 'light_sleep_duration') AS light_s,
  agent._num(r.json ->> 'rem_sleep_duration')   AS rem_s,
  agent._num(r.json ->> 'awake_time')           AS awake_s,
  agent._num(r.json ->> 'time_in_bed')          AS time_in_bed_s,
  agent._num(r.json ->> 'latency')              AS latency_s,
  agent._num(r.json ->> 'efficiency')           AS oura_efficiency_pct,
  NULL::double precision                        AS whoop_efficiency_pct,
  agent._num(r.json ->> 'average_heart_rate')   AS average_heart_rate,
  agent._num(r.json ->> 'lowest_heart_rate')    AS lowest_heart_rate,
  agent._num(r.json ->> 'average_hrv')          AS oura_average_hrv_ms,
  agent._num(r.json ->> 'average_breath')       AS respiratory_rate,
  NULL::double precision                        AS whoop_performance_pct,
  NULL::double precision                        AS whoop_consistency_pct,
  'records:oura:sleep:' || r.record_id          AS record_ref
FROM wearables.records r
WHERE r.provider = 'oura' AND r.data_type = 'sleep' AND r.is_current
  AND coalesce(r.json ->> 'type', '') <> 'deleted'
UNION ALL
SELECT
  'whoop',
  'whoop:sleep:' || r.record_id,
  ((r.end_time AT TIME ZONE 'UTC') + coalesce(agent._offset_minutes(r.json ->> 'timezone_offset'), 0) * interval '1 minute')::date,
  r.start_time,
  r.end_time,
  CASE WHEN agent._offset_minutes(r.json ->> 'timezone_offset') IS NOT NULL
       THEN (r.start_time AT TIME ZONE 'UTC') + agent._offset_minutes(r.json ->> 'timezone_offset') * interval '1 minute'
       ELSE agent.local_ts(r.start_time) END,
  CASE WHEN agent._offset_minutes(r.json ->> 'timezone_offset') IS NOT NULL
       THEN (r.end_time AT TIME ZONE 'UTC') + agent._offset_minutes(r.json ->> 'timezone_offset') * interval '1 minute'
       ELSE agent.local_ts(r.end_time) END,
  agent._offset_minutes(r.json ->> 'timezone_offset'),
  CASE WHEN (r.json ->> 'nap')::boolean THEN 'nap' ELSE 'sleep' END,
  NOT coalesce((r.json ->> 'nap')::boolean, false),
  r.json ->> 'score_state',
  (agent._num(r.json #>> '{score,stage_summary,total_light_sleep_time_milli}')
   + agent._num(r.json #>> '{score,stage_summary,total_slow_wave_sleep_time_milli}')
   + agent._num(r.json #>> '{score,stage_summary,total_rem_sleep_time_milli}')) / 1000,
  agent._num(r.json #>> '{score,stage_summary,total_slow_wave_sleep_time_milli}') / 1000,
  agent._num(r.json #>> '{score,stage_summary,total_light_sleep_time_milli}') / 1000,
  agent._num(r.json #>> '{score,stage_summary,total_rem_sleep_time_milli}') / 1000,
  agent._num(r.json #>> '{score,stage_summary,total_awake_time_milli}') / 1000,
  agent._num(r.json #>> '{score,stage_summary,total_in_bed_time_milli}') / 1000,
  NULL,
  NULL,
  agent._num(r.json #>> '{score,sleep_efficiency_percentage}'),
  NULL,
  NULL,
  NULL,
  agent._num(r.json #>> '{score,respiratory_rate}'),
  agent._num(r.json #>> '{score,sleep_performance_percentage}'),
  agent._num(r.json #>> '{score,sleep_consistency_percentage}'),
  'records:whoop:sleep:' || r.record_id
FROM wearables.records r
WHERE r.provider = 'whoop' AND r.data_type = 'sleep' AND r.is_current;

-- One provider-day of main sleep (the longest main period if several),
-- with that day's naps counted alongside (T17).
CREATE VIEW agent.v_sleep_nights AS
WITH ranked AS (
  SELECT s.*, row_number() OVER (PARTITION BY s.provider, s.day ORDER BY s.time_in_bed_s DESC NULLS LAST, s.start_utc) AS rn
  FROM agent.v_sleep_sessions s
  WHERE s.is_main
),
naps AS (
  SELECT provider, day, count(*)::int AS nap_count, coalesce(sum(total_sleep_s), 0) AS nap_sleep_s
  FROM agent.v_sleep_sessions WHERE NOT is_main
  GROUP BY provider, day
)
SELECT
  m.provider, m.day, m.session_key, m.start_utc, m.end_utc, m.start_local, m.end_local, m.utc_offset_minutes,
  m.score_state, m.total_sleep_s, m.deep_s, m.light_s, m.rem_s, m.awake_s, m.time_in_bed_s, m.latency_s,
  m.oura_efficiency_pct, m.whoop_efficiency_pct, m.average_heart_rate, m.lowest_heart_rate, m.oura_average_hrv_ms,
  m.respiratory_rate, m.whoop_performance_pct, m.whoop_consistency_pct,
  CASE WHEN m.provider = 'oura' THEN
    (SELECT agent._num(d.json ->> 'score') FROM wearables.records d
     WHERE d.provider = 'oura' AND d.data_type = 'daily_sleep' AND d.is_current AND d.day = m.day LIMIT 1)
  END                                AS oura_sleep_score,
  coalesce(n.nap_count, 0)          AS nap_count,
  coalesce(n.nap_sleep_s, 0)        AS nap_sleep_s,
  (SELECT count(*)::int FROM ranked r2 WHERE r2.provider = m.provider AND r2.day = m.day) AS main_sessions,
  m.record_ref
FROM ranked m
LEFT JOIN naps n ON n.provider = m.provider AND n.day = m.day
WHERE m.rn = 1;

-- One provider-day of readiness/recovery. Columns are named after the
-- provider so the two are never merged.
CREATE VIEW agent.v_recovery_daily AS
SELECT
  'oura'::text AS provider,
  r.day,
  agent._num(r.json ->> 'score')                          AS oura_readiness_score,
  agent._num(r.json ->> 'temperature_deviation')          AS oura_temperature_deviation_c,
  agent._num(r.json ->> 'temperature_trend_deviation')    AS oura_temperature_trend_deviation_c,
  agent._num(r.json #>> '{contributors,hrv_balance}')     AS oura_hrv_balance_score,
  agent._num(r.json #>> '{contributors,resting_heart_rate}') AS oura_resting_heart_rate_score,
  NULL::double precision AS whoop_recovery_score,
  NULL::double precision AS whoop_resting_heart_rate,
  NULL::double precision AS whoop_hrv_rmssd_ms,
  NULL::double precision AS whoop_spo2_pct,
  NULL::double precision AS whoop_skin_temp_c,
  NULL::double precision AS whoop_day_strain,
  NULL::boolean          AS whoop_calibrating,
  NULL::text             AS whoop_score_state,
  'records:oura:daily_readiness:' || r.record_id AS record_ref
FROM wearables.records r
WHERE r.provider = 'oura' AND r.data_type = 'daily_readiness' AND r.is_current
UNION ALL
SELECT
  'whoop',
  coalesce(((cy.start_time AT TIME ZONE 'UTC') + coalesce(agent._offset_minutes(cy.json ->> 'timezone_offset'), 0) * interval '1 minute')::date,
           agent.local_day((rc.json ->> 'created_at')::timestamptz)),
  NULL, NULL, NULL, NULL, NULL,
  agent._num(rc.json #>> '{score,recovery_score}'),
  agent._num(rc.json #>> '{score,resting_heart_rate}'),
  agent._num(rc.json #>> '{score,hrv_rmssd_milli}'),
  agent._num(rc.json #>> '{score,spo2_percentage}'),
  agent._num(rc.json #>> '{score,skin_temp_celsius}'),
  agent._num(cy.json #>> '{score,strain}'),
  (rc.json #>> '{score,user_calibrating}')::boolean,
  rc.json ->> 'score_state',
  'records:whoop:recovery:' || rc.record_id
FROM wearables.records rc
LEFT JOIN wearables.records cy
  ON cy.provider = 'whoop' AND cy.data_type = 'cycle' AND cy.is_current AND cy.record_id = rc.json ->> 'cycle_id'
WHERE rc.provider = 'whoop' AND rc.data_type = 'recovery' AND rc.is_current;

CREATE VIEW agent.v_workouts AS
SELECT
  w.provider,
  w.provider || ':workout:' || w.record_id AS workout_key,
  CASE WHEN w.provider = 'oura' THEN (w.json ->> 'day')::date
       ELSE ((w.start_time AT TIME ZONE 'UTC') + coalesce(agent._offset_minutes(w.json ->> 'timezone_offset'), 0) * interval '1 minute')::date END AS day,
  w.start_time                      AS start_utc,
  w.end_time                        AS end_utc,
  CASE WHEN w.provider = 'oura' THEN coalesce((w.json ->> 'start_datetime')::timestamp, agent.local_ts(w.start_time))
       WHEN agent._offset_minutes(w.json ->> 'timezone_offset') IS NOT NULL
         THEN (w.start_time AT TIME ZONE 'UTC') + agent._offset_minutes(w.json ->> 'timezone_offset') * interval '1 minute'
       ELSE agent.local_ts(w.start_time) END AS start_local,
  extract(epoch FROM (w.end_time - w.start_time))::int AS duration_s,
  w.activity,
  w.calories_kcal,
  w.distance_m,
  w.oura_intensity                  AS oura_intensity_label,
  w.whoop_strain,
  w.whoop_average_heart_rate,
  w.whoop_max_heart_rate,
  CASE WHEN w.provider = 'whoop' THEN w.json ->> 'score_state' END AS whoop_score_state,
  'records:' || w.provider || ':workout:' || w.record_id AS record_ref
FROM wearables.workouts w;

-- ============================================================
-- v_wearable_daily: one provider, metric and day (materialized)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('agent.v_wearable_daily') IS NOT NULL
     AND coalesce(obj_description(to_regclass('agent.v_wearable_daily'), 'pg_class'), '') <> 'v_wearable_daily v2' THEN
    DROP MATERIALIZED VIEW agent.v_wearable_daily CASCADE;
  END IF;
END $$;

-- Day attribution follows metric_catalog.day_anchor (4.6):
--   records_day: the provider's own day for the document the value came from
--                (Oura `day`; Whoop's local date of the cycle start or the
--                sleep's wake-up); Oura values at 00:00 UTC are that UTC date.
--   local_ts:    the sample's local day from the offset history.
--   sync_time:   the local day AyuOS noticed the change; is_sync_time = true.
-- Ordinals get counts per label instead of mean/median/sum (T8).
CREATE MATERIALIZED VIEW IF NOT EXISTS agent.v_wearable_daily AS
WITH anchors AS (
  SELECT DISTINCT ON (provider, anchor_ts) provider, anchor_ts, day
  FROM (
    SELECT 'oura'::text AS provider, coalesce(r.start_time, (r.json ->> 'timestamp')::timestamptz) AS anchor_ts, r.day
    FROM wearables.records r
    WHERE r.provider = 'oura' AND r.is_current AND r.day IS NOT NULL
    UNION ALL
    SELECT 'whoop', r.start_time,
           ((CASE WHEN r.data_type = 'sleep' THEN r.end_time ELSE r.start_time END AT TIME ZONE 'UTC')
             + coalesce(agent._offset_minutes(r.json ->> 'timezone_offset'), 0) * interval '1 minute')::date
    FROM wearables.records r
    WHERE r.provider = 'whoop' AND r.is_current AND r.data_type IN ('cycle', 'sleep', 'workout') AND r.start_time IS NOT NULL
    UNION ALL
    SELECT 'whoop', (rc.json ->> 'created_at')::timestamptz,
           ((cy.start_time AT TIME ZONE 'UTC') + coalesce(agent._offset_minutes(cy.json ->> 'timezone_offset'), 0) * interval '1 minute')::date
    FROM wearables.records rc
    JOIN wearables.records cy ON cy.provider = 'whoop' AND cy.data_type = 'cycle' AND cy.is_current AND cy.record_id = rc.json ->> 'cycle_id'
    WHERE rc.provider = 'whoop' AND rc.data_type = 'recovery' AND rc.is_current
  ) a
  WHERE anchor_ts IS NOT NULL
  ORDER BY provider, anchor_ts, day
),
r AS (
  SELECT
    rd.source_provider,
    rd.metric_type,
    rd.ts,
    rd.value,
    coalesce(c.value_kind, 'continuous_sample') AS value_kind,
    coalesce(c.day_anchor, 'local_ts') AS day_anchor,
    -- Whoop's max heart rate is both a cycle value and a body-measurement
    -- snapshot stamped at sync time (T9); snapshots match no cycle.
    (c.day_anchor = 'sync_time' OR (rd.source_provider = 'whoop' AND rd.metric_type = 'max_heart_rate' AND a.day IS NULL)) AS sync_snapshot,
    CASE coalesce(c.day_anchor, 'local_ts')
      WHEN 'records_day' THEN coalesce(
        a.day,
        CASE WHEN rd.source_provider = 'oura' AND (rd.ts AT TIME ZONE 'UTC')::time = '00:00' THEN (rd.ts AT TIME ZONE 'UTC')::date END,
        agent.local_day(rd.ts))
      ELSE agent.local_day(rd.ts)
    END AS local_day
  FROM timeseries.readings rd
  LEFT JOIN agent.metric_catalog c ON c.metric_type = rd.metric_type AND c.source_provider = rd.source_provider
  LEFT JOIN anchors a ON c.day_anchor = 'records_day' AND a.provider = rd.source_provider AND a.anchor_ts = rd.ts
)
SELECT
  source_provider,
  metric_type,
  local_day,
  count(*)::int                                                         AS n,
  CASE WHEN min(value_kind) <> 'ordinal' THEN avg(value) END            AS mean,
  min(value)                                                            AS min,
  max(value)                                                            AS max,
  CASE WHEN min(value_kind) <> 'ordinal' THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY value) END AS median,
  CASE WHEN min(value_kind) <> 'ordinal' THEN sum(value) END            AS sum,
  min(ts)                                                               AS first_ts,
  max(ts)                                                               AS last_ts,
  bool_or(sync_snapshot)                                                AS is_sync_time,
  CASE WHEN min(value_kind) = 'ordinal' THEN
    (SELECT jsonb_object_agg(k, cnt) FROM (
       SELECT x::text AS k, count(*) AS cnt FROM unnest(array_agg(value::int)) x GROUP BY x) s)
  END                                                                   AS value_counts
FROM r
GROUP BY source_provider, metric_type, local_day
WITH NO DATA;

COMMENT ON MATERIALIZED VIEW agent.v_wearable_daily IS 'v_wearable_daily v2';
CREATE UNIQUE INDEX IF NOT EXISTS v_wearable_daily_uk ON agent.v_wearable_daily (source_provider, metric_type, local_day);

-- Raw samples. Only reachable through tools that force a metric and a time
-- range (get_samples, and the SQL validator for model-written queries).
CREATE VIEW agent.v_readings AS
SELECT
  r.source_provider,
  r.metric_type,
  r.ts,
  agent.local_ts(r.ts)              AS local_ts,
  r.value,
  CASE WHEN c.value_kind = 'ordinal' THEN c.ordinal_labels ->> (r.value::int)::text END AS value_label,
  r.unit,
  r.context,
  'readings:' || r.source_provider || ':' || r.metric_type || ':' || r.ts AS record_ref
FROM timeseries.readings r
LEFT JOIN agent.metric_catalog c ON c.metric_type = r.metric_type AND c.source_provider = r.source_provider;

CREATE VIEW agent.v_metric_catalog AS
SELECT
  c.*,
  cov.first_day,
  cov.last_day,
  coalesce(cov.days_with_data, 0) AS days_with_data
FROM agent.metric_catalog c
LEFT JOIN LATERAL (
  SELECT min(d.local_day) AS first_day, max(d.local_day) AS last_day, count(*)::int AS days_with_data
  FROM agent.v_wearable_daily d
  WHERE d.source_provider = c.source_provider AND d.metric_type = c.metric_type
) cov ON true;

-- One row per data source: what it is, whether its login works, when data
-- last arrived. Hospital data is a one-time import per login (T16, E14, E15).
CREATE VIEW agent.v_data_freshness AS
SELECT
  'wearable'::text                  AS kind,
  p.provider                        AS source,
  CASE p.provider WHEN 'oura' THEN 'Oura' WHEN 'whoop' THEN 'Whoop' ELSE 'Apple Health' END AS display_name,
  CASE WHEN p.provider = 'apple_health' THEN 'manual_upload'
       ELSE coalesce(w.status, 'not_connected') END AS status,
  false                             AS sandbox,
  (SELECT max(d.last_ts) FROM agent.v_wearable_daily d WHERE d.source_provider = p.provider AND NOT d.is_sync_time) AS last_data_at,
  CASE WHEN p.provider = 'apple_health'
       THEN (SELECT max(s.finished_at) FROM ops.sync_runs s WHERE s.job = 'apple-health-upload' AND s.status = 'success')
       ELSE w.last_synced_at END    AS last_sync_at,
  w.last_error,
  NULL::int                         AS item_count
FROM (VALUES ('oura'), ('whoop'), ('apple_health')) AS p(provider)
LEFT JOIN ops.wearable_connections w ON w.provider = p.provider
UNION ALL
SELECT
  'hospital',
  c.slug,
  c.display_name,
  CASE WHEN c.sandbox THEN 'sandbox' ELSE 'connected' END,
  c.sandbox,
  (SELECT max(f.fetched_at) FROM clinical.fhir_resources f WHERE f.source = c.slug),
  (SELECT max(s.finished_at) FROM ops.sync_runs s WHERE s.job = 'ehr-import:' || c.slug AND s.status = 'success'),
  (SELECT s.error FROM ops.sync_runs s WHERE s.job = 'ehr-import:' || c.slug ORDER BY s.started_at DESC LIMIT 1),
  (SELECT count(*)::int FROM clinical.fhir_resources f WHERE f.source = c.slug AND f.is_current)
FROM ops.ehr_connections c
UNION ALL
SELECT
  'lab_pdf',
  'lab_pdf',
  'Uploaded lab reports',
  CASE WHEN EXISTS (SELECT 1 FROM labs.results r WHERE r.status = 'pending') THEN 'needs_review' ELSE 'manual_upload' END,
  false,
  (SELECT max(d.uploaded_at) FROM labs.documents d),
  (SELECT max(d.reviewed_at) FROM labs.documents d),
  NULL,
  (SELECT count(*)::int FROM labs.results r WHERE r.status = 'confirmed');
