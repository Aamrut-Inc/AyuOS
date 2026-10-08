CREATE SCHEMA IF NOT EXISTS labs;

-- One row per uploaded lab report PDF. The file itself is kept on disk
-- (content-addressed by sha256) so results can always be checked against it.
CREATE TABLE IF NOT EXISTS labs.documents (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256            TEXT NOT NULL UNIQUE,
  filename          TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  page_count        INT,
  extraction_method TEXT,          -- 'text' | 'ocr' | 'mixed'
  collected_date    DATE,          -- detected, then confirmed at review
  status            TEXT NOT NULL CHECK (status IN ('processing', 'needs_review', 'reviewed', 'failed')),
  error             TEXT,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at       TIMESTAMPTZ
);

-- Candidate results read from a document. Only 'confirmed' rows are real
-- data; 'pending' rows await review and 'rejected' ones are kept so a
-- re-parse doesn't resurrect them.
CREATE TABLE IF NOT EXISTS labs.results (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    BIGINT NOT NULL REFERENCES labs.documents(id) ON DELETE CASCADE,
  page           INT NOT NULL,
  row_index      INT NOT NULL,
  source_text    TEXT NOT NULL,
  analyte_name   TEXT NOT NULL,
  analyte_key    TEXT,
  loinc_code     TEXT,
  value_num      DOUBLE PRECISION,
  value_text     TEXT,
  comparator     TEXT,
  unit           TEXT,
  ref_low        DOUBLE PRECISION,
  ref_high       DOUBLE PRECISION,
  ref_text       TEXT,
  flag           TEXT,
  confidence     REAL NOT NULL,
  collected_date DATE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  reviewed_at    TIMESTAMPTZ,
  UNIQUE (document_id, page, row_index)
);

CREATE INDEX IF NOT EXISTS lab_results_analyte_idx
  ON labs.results (analyte_key, collected_date) WHERE status = 'confirmed';
