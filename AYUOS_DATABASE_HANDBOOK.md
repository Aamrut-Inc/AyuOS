# AyuOS Database Handbook

**For:** AI engineers building an agent that answers a person's questions about their own health data stored in AyuOS.
**Covers:** how the database is built, what it can hold, how data gets in and changes, and how to read it without getting wrong answers.
**Does not cover:** the person whose data is in it. No real names, IDs, dates or health values appear here. Examples marked **(synthetic)** are invented.

**Snapshot:** the database facts below were checked against the live database on 2026-10-22, using read-only queries. Counts and observed values will change as data arrives. The *structure* (tables, columns, rules) changes only when the code changes.

### How to read the source tags

Every fact carries one of these tags:

| Tag | Meaning |
|---|---|
| **[DB Qn]** | Checked in the live database with query *Qn* in [Appendix A](#appendix-a-evidence-queries). |
| **[Code `file`]** | Read from the code that creates or fills the database (paths are relative to the repo root). |
| **[Inference]** | My conclusion from the code and/or database. It wasn't stated anywhere directly. Treat it as likely, not certain. |
| **[Unknown]** | I couldn't determine it. |

---

## Contents

1. [What this database is for](#1-what-this-database-is-for)
2. [How the database is created](#2-how-the-database-is-created)
3. [How data gets in and changes over time](#3-how-data-gets-in-and-changes-over-time)
4. [Schemas and tables, column by column](#4-schemas-and-tables-column-by-column)
5. [How the tables relate, and tested joins](#5-how-the-tables-relate-and-tested-joins)
6. [Conventions](#6-conventions)
7. [Traps that cause wrong answers](#7-traps-that-cause-wrong-answers)
8. [What the design supports, cannot support, and is missing](#8-what-the-design-supports-cannot-support-and-is-missing)
9. [Rules for any agent reading this data](#9-rules-for-any-agent-reading-this-data)
10. [Cheat sheet (paste into a prompt)](#10-cheat-sheet-paste-into-a-prompt)
11. [Glossary](#11-glossary)
- [Appendix A: evidence queries](#appendix-a-evidence-queries)

---

## 1. What this database is for

AyuOS is a Mac app that keeps **one person's** health data on their own computer. The database is where all of that data lives. It is designed for a single user per install: there is no table of users, and the wearable readings carry a single `user_id` **[Code `extract/wearables/providers.ts` `localUserId`]** **[DB Q13: one distinct `user_id`]**.

It holds five kinds of data:

| Kind of data | Where it comes from | How it arrives | Where it is stored |
|---|---|---|---|
| **Hospital records** (diagnoses, lab results, vital signs, visits, medications, allergies, vaccines, procedures, clinical notes) | A hospital's **EHR** (electronic health record system). Today only **Epic** hospitals are supported, through the patient's **MyChart** login, using the **FHIR** standard | The user clicks *Connect* and logs in. Each login triggers **one full download**; there is no background refresh **[Code `app/server.ts` `/connect/ehr`, `extract/ehr/sync.ts`]** | schema `clinical` |
| **Files attached to hospital records** (note documents, report PDFs/HTML) | Same hospital, same login | Downloaded during the same import **[Code `extract/ehr/fhir/attachments.ts`]** | `clinical.fhir_attachments` (metadata); files on disk |
| **Wearable data** | **Oura** ring and **Whoop** band, through their web APIs | Automatically, every 30 minutes and after the Mac wakes **[Code `app/server.ts` `WEARABLE_SYNC_INTERVAL_MS`, `app/scheduler.ts`]** | `timeseries.readings` (numbers), `wearables.records` (original documents) |
| **Apple Health vitals** (heart rate, respiratory rate, blood oxygen, weight, height) | The iPhone Health app's export file (`export.zip`) | Uploaded by hand on the home page **[Code `extract/apple-health/parse-vitals.ts`]** | `timeseries.readings` with `source_provider = 'apple_health'` |
| **Lab results from PDF reports** | Lab report PDFs the user uploads | Uploaded by hand. The app reads the PDF, then the user must review the values **[Code `app/lab-import.ts`, `load/lab-store.ts`]** | schema `labs` |

There is also a command-line importer that loads clinical documents from an Apple Health export as FHIR records with `source = 'apple_health'` **[Code `cli/import-apple-health.ts`]**. It needs an external converter service and isn't reachable from the app UI **[Code `extract/apple-health/config.ts` `FHIR_CONVERTER_URL`]**. No such rows exist in the snapshot **[DB Q8]**.

The `ops` schema holds the app's own bookkeeping: connected hospitals, wearable logins, sync history. It is not health data.

---

## 2. How the database is created

### 2.1 What it is and where it lives

| Fact | Value | Source |
|---|---|---|
| Engine | PostgreSQL 17.5 | **[DB Q1]** |
| How it runs | AyuOS runs its own copy of Postgres as a normal process on the Mac (from the `@embedded-postgres` npm package). There is no Docker and no cloud server | **[Code `load/db-server.ts`]** |
| Files on disk | `~/Library/Application Support/AyuOS/data/postgres` | **[DB Q1]** **[Code `shared/data-dir.ts`, `load/db-server.ts` `clusterDir`]** |
| Address | `127.0.0.1`, port `5435`. Reachable only from the same Mac; no Unix socket | **[Code `load/db-server.ts`]** |
| User / database name | `ayuos` / `ayuos` | **[Code `load/db-server.ts`]** |
| Password | Random, made on first run, stored in the macOS **Keychain** (service `AyuOS`, account `database-password`) | **[Code `shared/keychain.ts`, `load/db-server.ts`]** |
| Time zone | `UTC` for the server and the database | **[DB Q1]** **[Code `load/db-server.ts`]** |
| Alternative | If the environment variable `DATABASE_URL` is set, AyuOS uses that Postgres instead | **[Code `load/config.ts`]** |
| Test database | `ayuos_test`, on the same server, used only by the automated tests | **[Code `test/setup.ts`]** |
| Files kept outside the database | Lab PDFs in `…/AyuOS/data/lab-pdfs/`, record attachments in `…/AyuOS/data/fhir-attachments/`. Each file is named by the **SHA-256 hash** (a fingerprint) of its contents | **[Code `app/lab-import.ts`, `load/attachment-store.ts`]** |

### 2.2 The table-definition files (migrations)

A **migration** is a SQL file that creates or changes tables. AyuOS has ten, in `load/migrations/`, applied in filename order **[Code `load/migrate.ts`]**:

| File | What it adds |
|---|---|
| `0001_init.sql` | Schema `clinical`; `clinical.fhir_resources` (raw hospital records with version history) |
| `0002_clinical_structured.sql` | Typed tables for Patient, Observation, Immunization, DiagnosticReport, DocumentReference, Procedure, plus their child tables |
| `0003_timeseries.sql` | Schema `timeseries`; `timeseries.readings`, split into one piece per month (partitioned) |
| `0004_sync_runs.sql` | Schema `ops`; `ops.sync_runs` (job history) |
| `0005_lab_results.sql` | Schema `labs`; `labs.documents`, `labs.results` |
| `0006_clinical_more_types.sql` | Typed tables for Condition, MedicationRequest, AllergyIntolerance, Encounter |
| `0007_fhir_attachments.sql` | `clinical.fhir_attachments` |
| `0008_ehr_connections.sql` | `ops.ehr_connections` (connected hospitals) |
| `0009_wearable_connections.sql` | `ops.wearable_connections` (Oura/Whoop logins) |
| `0010_wearables_everything.sql` | Schema `wearables`; `wearables.records`; the `context` column on readings; `ops.wearable_sync_state`; three views |

Every statement uses `CREATE … IF NOT EXISTS` (or `CREATE OR REPLACE VIEW`, or `ADD COLUMN IF NOT EXISTS`), so running all ten files again is harmless (**idempotent**) **[Code `load/migrations/*.sql`]**.

**Nothing records which migrations have run.** There is no migrations table; every file is simply executed again **[Code `load/migrate.ts`]**. *[Inference]* So a future migration that changes data, rather than only creating things, must be written so that running it twice is safe.

### 2.3 What happens when, step by step

| Moment | What happens | Source |
|---|---|---|
| **Setup / update** (`scripts/start.command`, which calls `scripts/install-agent.sh`) | Copies the app to `~/Library/Application Support/AyuOS/app`, runs `bun install`, then **runs all migrations** (`bun run migrate`). Then it installs a **launchd agent** (a macOS background service) that starts the app at login and restarts it if it crashes | **[Code `scripts/start.command`, `scripts/install-agent.sh`]** |
| **`bun run migrate`** | Starts the embedded database if needed: on first run it creates the data folder (`initdb`), sets it to listen only on 127.0.0.1:5435, and sets UTC. It then creates database `ayuos` if missing and applies all migration files | **[Code `load/migrate.ts`, `load/database.ts`, `load/db-server.ts`]** |
| **App start** (`app/server.ts`) | Makes the data folder private (permissions 0700), then makes sure the database is running (`ensureDatabase`). **It does not run migrations.** It starts the web server on 127.0.0.1:3000, then starts the scheduler | **[Code `app/server.ts`, `app/stack.ts`, `shared/data-protection.ts`]** |
| **Scheduler start** | Any sync left in `status = 'running'` by a crash is marked `failed`. Each job is treated as just woken up, so the wearable syncs run right away | **[Code `app/scheduler.ts`, `load/sync-runs.ts` `markInterruptedRuns`]** |
| **Every 30 seconds** | The scheduler checks which jobs are due. If more than 2 minutes passed since the last check (the laptop was asleep), it treats that as a wake and catches up. It waits until the network is reachable (DNS lookup of `api.ouraring.com`) | **[Code `app/scheduler.ts`]** |

There are **no triggers and no stored functions** in the database, so all logic lives in the app code **[DB Q7]**.

---

## 3. How data gets in and changes over time

### 3.1 Hospital records (EHR → `clinical`)

1. **Login.** The user picks a hospital from Epic's public directory and logs in through MyChart (**SMART on FHIR**, a standard way to log into a hospital's FHIR server using **OAuth**). Each hospital is saved in `ops.ehr_connections` under a short name (`slug`), made from the hospital's name: lowercase, with non-alphanumeric characters replaced by `_` (and `_2`, `_3`… on clashes) **[Code `load/ehr-connections.ts` `slugFor`, `add`]**.
2. **Download.** For each of 19 resource types (Patient, AllergyIntolerance, CarePlan, CareTeam, Condition, Device, DiagnosticReport, DocumentReference, Encounter, FamilyMemberHistory, Goal, Immunization, MedicationRequest, MedicationStatement, Observation, Procedure, QuestionnaireResponse, ServiceRequest, Specimen), the importer runs:
   - one search without a category, plus
   - one search per configured category: 20 categories for Observation, 4 for Condition, `clinical-note` for DocumentReference.

   It follows every results page and removes duplicates by resource id **[Code `extract/ehr/config.ts`, `extract/ehr/fhir/client.ts`]**. If the server refuses a search with HTTP 400/403/404/422, that type is skipped; other errors fail the import **[Code `extract/ehr/fhir/client.ts` `unsupported`]**.
3. **Raw storage with history** (`clinical.fhir_resources`). Each resource is saved as JSON together with its SHA-256 hash:
   - unchanged (same hash): nothing is written;
   - changed: the old row gets `is_current = false`, and a new row is added with `version + 1`;
   - nothing is ever deleted **[Code `load/raw-store.ts`]**.

   Every row from one import gets the same `patient_id`: the patient id the hospital returned at login **[Code `extract/ehr/sync.ts`, `load/raw-store.ts`]**.
4. **Structured copy** (the typed `clinical.*` tables). Right after the import, `runTransform` reads every *current* raw row of the 10 supported types and **inserts or overwrites** (an **upsert**) one row per `(source, resource_id)`. Its child tables (codes, identifiers, attachments list) are **deleted and rebuilt**. A row whose hash hasn't changed is skipped **[Code `transform/run.ts`, `transform/*.ts`]**.
5. **Attachments.** Files referenced by DocumentReference and DiagnosticReport are downloaded while the login is still valid. A failed download is recorded with an `error` and retried on the next import. A URL that already downloaded successfully is skipped **[Code `extract/ehr/sync.ts`, `load/attachment-store.ts`]**.

**Kept vs overwritten (hospital data)** **[Code, same files]**:

| Table | Old values kept? | Deleted ever? |
|---|---|---|
| `clinical.fhir_resources` | **Yes.** Every version is kept, and `is_current` marks the latest | Never |
| Typed tables (`clinical.observation` etc.) | **No.** Overwritten in place; current state only | Never by the app, even if the hospital later removes the record |
| Child `*_coding` / `*_identifier` / `*_content` / `*_presented_form` tables | No. Rebuilt on each change | Rebuilt rows replace old ones |
| `clinical.fhir_attachments` | No. Upserted per `(source, resource_type, resource_id, url)` | Never |

*[Inference]* If a hospital deletes or merges a record, AyuOS keeps the last copy it saw as "current". The design has no way to tell "still true" apart from "no longer returned by the hospital".

### 3.2 Wearables (Oura, Whoop → `wearables.records` and `timeseries.readings`)

- **When:** the jobs `wearables-oura` and `wearables-whoop` run every 30 minutes, after a wake, on *Sync now*, and right after a new login **[Code `app/server.ts`, `app/scheduler.ts`]**. Failures retry with growing waits (1, 2, 4 … up to 30 minutes) **[Code `app/scheduler.ts`]**.
- **What is requested:** every data endpoint of both APIs **[Code `extract/wearables/oura.ts` `OURA_TYPES`, `extract/wearables/whoop.ts` `WHOOP_TYPES`]**:
  - Oura (19): `daily_activity`, `daily_sleep`, `daily_readiness`, `daily_spo2`, `daily_stress`, `daily_resilience`, `daily_cardiovascular_age`, `vO2_max`, `sleep`, `sleep_time`, `workout`, `session`, `enhanced_tag`, `tag`, `rest_mode_period`, `heartrate`, `ring_battery_level`, `ring_configuration`, `personal_info`.
  - Whoop (6): `cycle`, `recovery`, `sleep`, `workout`, `profile`, `body_measurement`.
- **Time window:** each data type has its own resume point in `ops.wearable_sync_state`. Each sync asks for *resume point − 3 days* up to now; the first time, it asks for 10 years. The 3-day overlap catches late uploads and summaries the provider finalizes after the day ends **[Code `extract/wearables/sync.ts`]**.
  - Exception: Oura `heartrate` continues from the provider-wide resume point (`ops.wearable_connections.last_synced_at`) when it has no per-type point yet, so years of heart rate aren't downloaded again **[Code `extract/wearables/sync.ts` `RESUME_FROM_PROVIDER`]**.
- **"Snapshot" types** (`ring_configuration`, `personal_info`, `profile`, `body_measurement`) describe the account's current state. They are fetched whole every sync and have no resume point **[Code]**.
- **Original documents → `wearables.records`:** versioned exactly like hospital records (same hash rule, old versions kept, `is_current`) **[Code `load/wearable-records.ts`]**. *Not* stored for `heartrate` and `ring_battery_level`: every field of those is already captured as readings **[Code `extract/wearables/oura.ts` `byDatetime`]**.
- **Numbers → `timeseries.readings`:** every numeric field becomes a reading (the list is in §4.3) **[Code `oura.ts`, `whoop.ts`]**. Rules:
  - a reading is identified by `(user_id, metric_type, ts, source_provider)`, and a later sync with the same identity **overwrites** `value`, `unit`, `source_device`, `context` and `fetched_at` **[Code `load/timeseries.ts`]**;
  - **no history is kept** for readings;
  - readings are **never deleted** by the app **[Code]**;
  - empty or non-numeric values are dropped and never stored **[Code `extract/wearables/readings.ts`]**.
- **Whoop scoring:** Whoop documents that aren't yet scored (`score_state` other than `SCORED`) are kept in `wearables.records` but produce no readings until Whoop scores them **[Code `extract/wearables/whoop.ts`]**.
- **Weight, height and Whoop max heart rate snapshots:** stored as a reading **only when the value changed** (by more than 0.01) since the last stored value. The reading's timestamp is **the time of the sync**, not the time of measurement **[Code `extract/wearables/sync.ts` `changedSnapshots`]**.
- **Data the user didn't share:** a data type Oura refuses (403/404, or 401 even with a freshly renewed token) is skipped and listed under `skipped` in the sync log **[Code `extract/wearables/api.ts`, `sync.ts`]**.
- **History before 2026-10-12:** readings with an earlier `fetched_at` were written by an older wearables backend and then copied into this database **[Code `scripts/migrate-off-docker.ts`]** **[DB Q35]**. They use the same metric names, but have no `context` and no matching document in `wearables.records` **[DB Q14, Q27]**.

### 3.3 Apple Health (upload → `timeseries.readings`)

The upload reads `export_cda.xml` from the zip and keeps observations with one of five **LOINC** codes. Each becomes a metric **[Code `extract/apple-health/parse-vitals.ts`]**:

| LOINC code | `metric_type` |
|---|---|
| 8302-2 | `height` |
| 8867-4 | `heart_rate` |
| 2710-2 | `oxygen_saturation` |
| 9279-1 | `respiratory_rate` |
| 3141-9 | `weight` |

- Apple stores blood oxygen as a fraction (0.96). AyuOS converts it to a percentage (96) so it matches Oura and Whoop **[Code]** **[DB Q25b: all providers on the 0–100 scale]**.
- Duplicates in the export (same metric, same instant) are merged into one reading. Uploading again overwrites the same readings instead of duplicating them **[Code]**.
- Everything else in the export is ignored **[Code]**.

### 3.4 Lab PDFs (upload → `labs`)

1. **Upload.** The file must start with `%PDF-`. Its SHA-256 hash identifies it: uploading the same file again returns the existing document and adds nothing **[Code `app/lab-import.ts`]**.
2. **Reading.** Text is taken from the PDF's text layer, or recognized from images (**OCR**) for scanned pages. Each line is parsed into a *candidate* result with a confidence score:
   - +0.4 if the test was recognized,
   - +0.25 if a unit was found,
   - +0.25 if a reference range was found,
   - +0.1 if the value is a number.

   Lines scoring under 0.5 are dropped **[Code `transform/lab-results.ts`]**. New candidates get `status = 'pending'`, and the document becomes `needs_review` **[Code `load/lab-store.ts`]**.
3. **Review by the user.** On the review page each row is accepted (`confirmed`) or rejected (`rejected`). Name, value, unit, range and flag can be corrected, and one collection date is set for the whole document **[Code `load/lab-store.ts` `saveReview`, `app/server.ts`]**.
4. **Re-reading** a stored PDF (after parser improvements) deletes only `pending` rows. `confirmed` and `rejected` rows are kept, so rejected rows don't come back **[Code `load/lab-store.ts` `saveExtraction`]**.

**Only `confirmed` rows are real data.** `pending` rows are unchecked machine guesses; `rejected` rows are known to be wrong **[Code comment `load/migrations/0005_lab_results.sql`]**.

### 3.5 Summary: what is history, what is current

| Table | Model | Duplicates prevented by |
|---|---|---|
| `clinical.fhir_resources` | Append-only versions | Partial unique index: one `is_current` row per `(source, resource_type, resource_id)` **[DB Q6]** |
| `wearables.records` | Append-only versions | Same pattern on `(provider, data_type, record_id)` **[DB Q6]** |
| `clinical.*` typed tables | Current state only | `UNIQUE (source, resource_id)` **[DB Q5]** |
| `timeseries.readings` | Current value only (overwrite) | Primary key `(user_id, metric_type, ts, source_provider)` **[DB Q5]** |
| `labs.results` | Status workflow | `UNIQUE (document_id, page, row_index)` **[DB Q5]** |
| `labs.documents` | One row per distinct file | `UNIQUE (sha256)` **[DB Q5]** |
| `ops.sync_runs` | Append-only log | None (one row per attempt) |

---

## 4. Schemas and tables, column by column

**Notation.** *Null?* "no" means the database requires a value (`NOT NULL`). "Options" lists fixed values:

- *enforced* = a `CHECK` rule in the database **[DB Q5]**;
- *code* = the only values the code writes **[Code]**;
- *observed* = values seen in the snapshot, with other values possible **[DB]**.

All column types, nullability and defaults come from **[DB Q4]**; all keys and checks from **[DB Q5]**; indexes from **[DB Q6]**.

### 4.0 Overview

| Schema | Tables / views | Purpose |
|---|---|---|
| `clinical` | `fhir_resources`, `fhir_attachments`, 10 typed tables, 12 child tables | Hospital records |
| `timeseries` | `readings` (partitioned by month) | Every numeric wearable and Apple Health value |
| `wearables` | `records`; views `oura_sleep`, `whoop_sleep`, `workouts` | Original Oura/Whoop documents |
| `labs` | `documents`, `results` | Lab PDF uploads and the values read from them |
| `ops` | `ehr_connections`, `wearable_connections`, `wearable_sync_state`, `sync_runs` | App bookkeeping |
| `public` | (empty) | Not used |

**[DB Q2]**

### 4.1 Schema `clinical`: hospital records

#### `clinical.fhir_resources`: the raw store

One row = **one version of one FHIR resource** (one record, such as one lab value or one diagnosis) from one source.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `id` | bigint, auto-generated | no | Row id. Primary key |
| `source` | text | no | Where it came from: the hospital's `slug` from `ops.ehr_connections`, or `apple_health` (command-line importer) **[Code]**. Observed: one sandbox hospital **[DB Q8]** |
| `patient_id` | text | yes | The patient's id **at that hospital**, as a bare id (no `Patient/` prefix) **[DB Q22]** |
| `resource_type` | text | no | FHIR type. Options (code): the 19 types in §3.1. Observed: 13 types **[DB Q8]** |
| `resource_id` | text | no | The hospital's id for the resource, unique only within `source` + `resource_type` |
| `version` | integer | no (default 1) | 1, 2, 3… increases each time the content changes |
| `is_current` | boolean | no (default true) | `true` only on the latest version |
| `json` | jsonb | no | The complete resource exactly as received. Every row holds a JSON object **[DB Q29]** |
| `content_hash` | text | no | SHA-256 of the JSON text, used to detect changes |
| `date_low`, `date_high`, `date_sort` | timestamptz | yes | **Never filled in:** NULL in every row **[DB Q9]** **[Code: no writer exists]**. Do not use |
| `fetched_at` | timestamptz | no (default now()) | When this version was saved |

The unique index `fhir_resources_current_uk` allows only one `is_current` row per `(source, resource_type, resource_id)`.

Types that are stored here **but have no typed table** (readable only through `json`): CarePlan, CareTeam, Device, FamilyMemberHistory, Goal, MedicationStatement, QuestionnaireResponse, ServiceRequest, Specimen **[Code `transform/run.ts`]**. Observed raw-only types: CareTeam, Goal, ServiceRequest **[DB Q28]**.

#### Shared columns of every typed table

The ten typed tables (`patient`, `observation`, `condition`, `encounter`, `diagnostic_report`, `document_reference`, `procedure`, `immunization`, `medication_request`, `allergy_intolerance`) all start with these columns. One row = **the current state of one FHIR resource**.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `id` | bigint, auto | no | Row id. Primary key. Child tables point to it |
| `fhir_resource_id` | bigint | no | Foreign key → `clinical.fhir_resources.id`: the raw version this row was built from |
| `source` | text | no | Same as in `fhir_resources` |
| `resource_id` | text | no | Same as in `fhir_resources`. `UNIQUE (source, resource_id)` |
| `content_hash` | text | no | Hash of the raw version used; lets the transform skip unchanged records |
| `transformed_at` | timestamptz | no (default now()) | When this row was last built |

Clinical `status` fields are free text. The database doesn't restrict them; they hold whatever code the hospital sent **[DB Q5: no CHECK]**.

Child tables named `*_coding` share this shape. A **coding** is one code from one standard medical vocabulary; a record can carry several codings that mean the same thing in different vocabularies.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `id` | bigint | no | Primary key |
| `<parent>_id` | bigint | no | Foreign key → parent `id`, `ON DELETE CASCADE` (deleting the parent deletes these) |
| `system` | text | yes | URI of the code system, e.g. `http://loinc.org` (see §6.5) |
| `code` | text | no | The code |
| `display` | text | yes | Human-readable name of the code |

#### `clinical.patient` (+ `patient_identifier`)

One row = one patient record from one source.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `family_name` | text | yes | Last name from the "official" name (or the first name listed) |
| `given_names` | text[] | yes | First/middle names |
| `gender` | text | yes | Administrative gender as sent |
| `birth_date` | date | yes | Date of birth |
| `address_line`, `address_city`, `address_state`, `address_postal_code`, `address_country` | text | yes | **First** address only, with lines joined by ", " |
| `phone`, `email` | text[] | yes | All phone numbers / emails |
| `marital_status_code`, `marital_status_display` | text | yes | Marital status code and text |
| `language` | text | yes | Preferred language code (or the first listed) |

**[Code `transform/patient.ts`]**. This table is **personal identifying information (PII)**: never show it unless the user asks.

`clinical.patient_identifier`: one row = one identifier of the patient (e.g. a medical record number). Columns: `patient_id` (bigint, foreign key → `clinical.patient.id`, **not** the FHIR id), `system` (text, null ok), `value` (text, not null).

#### `clinical.observation` (+ `observation_code_coding`)

One row = one **Observation**: a single measurement or finding, such as a lab value, a vital sign, a survey answer, or a social-history item.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `status` | text | yes | Observed: `final` only **[DB Q30]**. *[Inference: FHIR]* also `preliminary`, `amended`, `cancelled`, `entered-in-error`, … |
| `patient_id` | text | yes | Bare FHIR patient id |
| `encounter_id` | text | yes | Bare FHIR id of the visit it belongs to |
| `performer_refs` | text[] | yes | Who performed it, as full references like `Practitioner/…` **[DB Q22]** |
| `has_member_refs` | text[] | yes | For a **panel** (a group observation): references to its member observations, like `Observation/…` |
| `derived_from_refs` | text[] | yes | Observations this one was calculated from (full references) |
| `category_codes` | text[] | yes | Category codes. Observed: `vital-signs`, `laboratory`, `Lab`, `imaging`, `activity`, `survey`, `sdoh`, `social-history`, `study-finding`, `Echo` **[DB Q30]**. Note the mixed spelling (`laboratory` vs `Lab`) |
| `value_quantity_value` | double | yes | Numeric value |
| `value_quantity_unit` | text | yes | Unit as written by the hospital |
| `value_quantity_code` | text | yes | Unit code (usually **UCUM**, a standard unit syntax) |
| `value_text` | text | yes | Text of a coded value |
| `value_code`, `value_code_system` | text | yes | First code of a coded value, and its code system |
| `effective_datetime` | timestamptz | yes | When it was measured/observed (only if the hospital sent a single instant) |

Codes for *what* was measured are in `observation_code_coding` (one observation usually has several; the maximum seen is 7 **[DB Q21b]**).

**Not captured in this table** **[Code `transform/observation.ts`]**:
- `component` (multi-part values; *[Inference]* typically blood pressure's two numbers);
- `valueString`, `valueBoolean` and other value types;
- `effectivePeriod`;
- `interpretation` (high/low flags);
- `referenceRange` (normal range);
- `note`.

90 current observations have components and **no** structured value **[DB Q24]**. Read them from `fhir_resources.json` (see query E8).

#### `clinical.condition` (+ `condition_coding`)

One row = one **Condition**: a diagnosis, problem-list entry, visit diagnosis, or health concern.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `clinical_status` | text | yes | First code of `clinicalStatus`. Observed: `active`, NULL **[DB Q30]**. *[Inference: FHIR standard values, not checked in code or DB]* active, recurrence, relapse, inactive, remission, resolved |
| `verification_status` | text | yes | First code of `verificationStatus`. Observed: `confirmed`, NULL **[DB Q30]**. *[Inference: FHIR standard values]* unconfirmed, provisional, differential, confirmed, refuted, entered-in-error |
| `category_codes` | text[] | yes | Observed: `problem-list-item`, `encounter-diagnosis`, `visit-diagnosis` (Epic adds its own codes) |
| `patient_id`, `encounter_id` | text | yes | Bare FHIR ids |
| `code_text` | text | yes | Readable name: the record's own text, else the first coding's display, else its code **[Code `transform/fhir-helpers.ts` `conceptText`]** |
| `onset_datetime` / `onset_text` | timestamptz / text | yes | When it started: padded timestamp / exactly what the source said (may be partial, like "2019", or free text) |
| `abatement_datetime` / `abatement_text` | timestamptz / text | yes | When it ended/resolved, same rule |
| `recorded_date` | timestamptz | yes | When it was recorded |

#### `clinical.encounter` (+ `encounter_type_coding`)

One row = one **Encounter**: a visit, admission, phone or video contact, or other interaction.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `status` | text | yes | Observed: `finished`, `in-progress`, `unknown` **[DB Q30]**. *[Inference]* `in-progress` from a sandbox doesn't necessarily mean ongoing |
| `class_code`, `class_display` | text | yes | Encounter class. Epic sends **its own short numeric codes** with display text, not the standard HL7 class codes **[DB Q30]** |
| `type_text` | text[] | yes | Readable visit types |
| `patient_id` | text | yes | Bare FHIR id |
| `period_start`, `period_end` | timestamptz | yes | Start/end (padded if partial) |
| `service_provider_ref`, `service_provider_name` | text | yes | Organization reference and name |
| `location_names` | text[] | yes | Location names |
| `participant_refs` | text[] | yes | Clinicians, as full references (`Practitioner/…`) |
| `reason_text` | text[] | yes | Reasons for the visit |

#### `clinical.diagnostic_report` (+ `diagnostic_report_coding`, `diagnostic_report_presented_form`)

One row = one **DiagnosticReport**: a lab panel, imaging report, pathology report, etc., grouping results and/or a written conclusion.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `status` | text | yes | Observed: `final` |
| `patient_id`, `encounter_id` | text | yes | Bare FHIR ids |
| `category_codes` | text[] | yes | Mix of standard codes, LOINC "part" codes (`LP…`) and free text **[DB Q30]** |
| `effective_datetime` | timestamptz | yes | When the specimen/study was taken |
| `issued` | timestamptz | yes | When the report was released |
| `conclusion_text` | text | yes | Written conclusion |
| `result_observation_ids` | text[] | yes | **Bare** ids of the Observations in this report **[DB Q22]** |

`diagnostic_report_coding` adds `field` (text, not null; **enforced options:** `code` = what the report is, `conclusion_code` = coded conclusion/diagnosis).
`diagnostic_report_presented_form`: one row = one attached rendering of the report. Columns: `content_type`, `url`, `title` (all text, null ok).

#### `clinical.document_reference` (+ `document_reference_type_coding`, `document_reference_content`)

One row = one **DocumentReference**: a pointer to a clinical document such as a visit note or discharge summary.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `status` | text | yes | Observed: `current` |
| `patient_id` | text | yes | Bare FHIR id |
| `category_codes` | text[] | yes | e.g. `clinical-note` |
| `date` | timestamptz | yes | Document date |
| `author_refs` | text[] | yes | Full references (`Practitioner/…`) |
| `encounter_ids` | text[] | yes | **Bare** encounter ids |
| `context_period_start`, `context_period_end` | timestamptz | yes | Period the document covers |

`document_reference_type_coding`: the codes for the document type. `document_reference_content`: one row per attached file, with `content_type`, `url`, `title` and `position` (0-based order). The files themselves: `clinical.fhir_attachments`.

#### `clinical.procedure` (+ `procedure_coding`)

One row = one **Procedure** (surgery, test procedure, therapy).

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `status` | text | yes | Observed: `completed` |
| `patient_id` | text | yes | Bare id |
| `category_code`, `category_system`, `category_display` | text | yes | First category coding |
| `performed_datetime` | timestamptz | yes | Only if sent as a single instant (`performedPeriod` is ignored **[Code]**) |
| `report_diagnostic_report_ids` | text[] | yes | Bare ids of related DiagnosticReports |
| `performer_refs` | text[] | yes | Full references |

`procedure_coding.field`: **enforced options** `code` (what was done) and `reason_code` (why).

#### `clinical.immunization` (+ `immunization_vaccine_coding`)

One row = one vaccine dose given (or recorded as not given).

Columns: `status` (observed `completed`), `patient_id`, `occurrence_datetime`, `dose_quantity_value` (double) / `dose_quantity_unit`, `site_code/system/display` (body site), `route_code/system/display` (how it was given), `lot_number`, `manufacturer_display`, `performer_refs` (full references). Vaccine codes are in `immunization_vaccine_coding` (observed systems: **CVX** and **NDC** **[DB Q21]**). All are nullable.

#### `clinical.medication_request` (+ `medication_request_coding`)

One row = one **MedicationRequest**: a prescription or medication order. It is *not* proof the person took the medication.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `status` | text | yes | Observed: `active` **[DB Q30]**. *[Inference: FHIR standard values]* active, on-hold, cancelled, completed, entered-in-error, stopped, draft, unknown |
| `intent` | text | yes | Observed: `order` **[DB Q30]**. *[Inference: FHIR]* also `plan`, `proposal`, … |
| `patient_id`, `encounter_id` | text | yes | Bare ids |
| `authored_on` | timestamptz | yes | When it was written |
| `medication_text` | text | yes | Drug name: from the inline code, else from the reference's display text (Epic's usual form) **[Code `transform/medication-request.ts`]** |
| `medication_ref` | text | yes | Full reference to a Medication resource (`Medication/…`) **[DB Q22]** |
| `dosage_text` | text | yes | All dosage instruction texts, joined with "; " |
| `requester_ref` | text | yes | Prescriber, full reference |
| `reason_text` | text[] | yes | Reasons |

`medication_request_coding` holds codes only when the drug is coded inline. With Epic's reference style it stays **empty** (0 rows in the snapshot **[DB Q8b]**).

#### `clinical.allergy_intolerance` (+ `allergy_intolerance_coding`)

One row = one allergy or intolerance.

Columns: `clinical_status`, `verification_status` (first codes), `type` (allergy/intolerance), `categories` (text[]: food, medication, environment, biologic), `criticality` (low/high/unable-to-assess), `patient_id`, `substance_text`, `onset_datetime` / `onset_text`, `recorded_date`, `reactions` (text[] of reaction descriptions), `reaction_severities` (text[]: mild/moderate/severe). The value lists in parentheses are FHIR standard values given for orientation *[Inference]*; neither the code nor the database enforces them.

*[Inference]* `reactions` and `reaction_severities` are two separately flattened lists, so their positions don't necessarily line up when there are several reactions.

#### `clinical.fhir_attachments`

One row = one file attached to a hospital record.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `source`, `resource_type`, `resource_id` | text | no | Which record it belongs to (resource_type is `DocumentReference` or `DiagnosticReport` **[Code `extract/ehr/fhir/attachments.ts`]**) |
| `url` | text | no | Original URL, or `inline:<sha256>` when the file was embedded in the JSON |
| `title`, `content_type` | text | yes | Name and file type (observed: HTML, XML, RTF **[DB Q24b]**) |
| `sha256`, `file_path`, `size_bytes` | text, text, bigint | yes | Fingerprint, local path, size. Set when the download succeeded |
| `error` | text | yes | Set when the download failed (retried next import) |
| `fetched_at` | timestamptz | no | When saved |

`UNIQUE (source, resource_type, resource_id, url)`.

### 4.2 Schema `wearables`: original Oura/Whoop documents

#### `wearables.records`

One row = **one version of one document** from Oura or Whoop (a night's sleep session, a day's readiness summary, a workout, a profile…).

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `id` | bigint | no | Primary key |
| `provider` | text | no | Options (code): `oura`, `whoop` |
| `data_type` | text | no | Provider's name for the document type. Options (code): the 19 Oura and 6 Whoop names in §3.2 except `heartrate` and `ring_battery_level` |
| `record_id` | text | no | Provider's id. Whoop `recovery` uses the `cycle_id`; Whoop body measurement uses `body`; a document without an id uses a hash of its content **[Code]** |
| `version`, `is_current` | int, bool | no | Version history, same rules as `fhir_resources` |
| `json` | jsonb | no | Complete document |
| `content_hash` | text | no | SHA-256 of the JSON |
| `day` | date | yes | The calendar day the provider assigns it to (Oura `day`/`start_day`). NULL for Whoop and for snapshots **[Code]** **[DB Q16]** |
| `start_time`, `end_time` | timestamptz | yes | Start/end of the thing described, when it has one |
| `fetched_at` | timestamptz | no | When this version was saved |

The provider's **local time and UTC offset are kept only inside `json`** (e.g. Oura `bedtime_start` includes an offset like `+02:00` (synthetic); Whoop has `timezone_offset`). The timestamptz columns are converted to UTC **[DB Q31]** **[Inference from Postgres behavior]**.

`personal_info` (Oura) and `profile` (Whoop) contain **email, age, sex, name**, which is PII **[Code `OURA_TYPES`, `WHOOP_TYPES`]**.

#### Views (saved queries over `records`, current versions only) **[Code `0010_wearables_everything.sql`]**

| View | One row = | Key columns |
|---|---|---|
| `wearables.oura_sleep` | one Oura sleep period | `day`, `start_time`, `end_time`, `sleep_type` (options observed: `long_sleep`, `sleep`, `late_nap` **[DB Q34]**; Oura also defines `rest`, `deleted` *[Unknown which appear]*), `total_sleep_s`, `deep_s`, `light_s`, `rem_s`, `awake_s`, `time_in_bed_s`, `latency_s`, `efficiency_pct`, `average_heart_rate`, `lowest_heart_rate`, `average_hrv_ms`, `average_breath_rate`, `restless_periods`, `hypnogram_5_min`, `json` |
| `wearables.whoop_sleep` | one Whoop sleep | `nap`, `score_state`, `performance_pct`, `efficiency_pct`, `consistency_pct`, `respiratory_rate`, `time_in_bed_s` … `rem_s` (integer seconds, rounded down), `sleep_cycles`, `disturbances`, `json` |
| `wearables.workouts` | one workout, either provider | `provider`, `activity` (Oura `activity` / Whoop `sport_name`), `calories_kcal` (Whoop kJ ÷ 4.184), `distance_m`, `oura_intensity`, `whoop_strain`, `whoop_average_heart_rate`, `whoop_max_heart_rate`, `json` |

A single Oura `day` can have **several** sleep periods (up to 4 in the snapshot **[DB Q34]**). Naps and main sleep are separate rows.

### 4.3 Schema `timeseries`: `timeseries.readings`

One row = **one numeric value of one metric at one instant from one provider**.

| Column | Type | Null? | Meaning |
|---|---|---|---|
| `user_id` | text | no | The single local user (from setting `AYUOS_USER_ID`, default `me`) **[Code]** |
| `metric_type` | text | no | What was measured (catalog below) |
| `ts` | timestamptz | no | The instant the value applies to (see §6.4 for daily values) |
| `value` | double | no | The number |
| `unit` | text | yes | Unit as written by AyuOS's mapping code (not standardized across providers, see trap T6) |
| `source_provider` | text | no | Options (code): `oura`, `whoop`, `apple_health` |
| `source_device` | text | yes | **Always NULL**; never filled **[DB Q13]** **[Code `readings.ts`]** |
| `fetched_at` | timestamptz | no | When last written |
| `context` | text | yes | Qualifier: what the person was doing, sleep type, sport, etc. (table below). NULL on all rows written before 2026-10-22 **[DB Q14]** |

Primary key `(user_id, metric_type, ts, source_provider)`. Extra index `(user_id, metric_type, ts)`.

**Partitioning:** the table is split into one sub-table per calendar month (UTC), named `timeseries.readings_YYYY_MM`. Sub-tables are created automatically when data for a new month arrives **[Code `load/timeseries.ts`]** **[DB Q3, Q32]**. Always query the parent `timeseries.readings`, never a month table.

**Metric catalog** **[Code `extract/wearables/oura.ts`, `whoop.ts`, `extract/apple-health/parse-vitals.ts`]** **[DB Q11: units as stored]**

Oura metrics:

| Group | `metric_type` (unit) | Timestamp anchor | `context` |
|---|---|---|---|
| Continuous heart | `heart_rate` (bpm) | each sample | Oura's sample source: observed `awake`, `rest`, `sleep`, `workout` (spec also lists `live`, `session`) **[DB Q12]** |
| | `heart_rate_variability_sdnn` (ms) | each 5-min sample during sleep | `sleep` |
| Daily activity | `steps` (count), `energy` (**active** kcal), `total_energy` (kcal), `target_energy` (kcal), `distance_walking_running`, `target_distance`, `distance_to_target` (meters), `activity_score` (score), `activity_contributor_<name>` (score: `meet_daily_targets`, `move_every_hour`, `recovery_time`, `stay_active`, `training_frequency`, `training_volume`), `inactivity_alerts` (count), `average_met_minutes`, `high_/medium_/low_activity_met_minutes`, `sedentary_met_minutes` (met_min), `high_/medium_/low_activity_time`, `sedentary_time`, `resting_time`, `non_wear_time` (s) | Oura's activity-day timestamp (local day start converted to UTC) | — |
| | `met` (met), 1-minute samples | each minute | — |
| | `activity_class` (class; 0 non-wear, 1 rest, 2 inactive, 3 low, 4 medium, 5 high) | each 5 minutes | — |
| Daily sleep | `sleep_score`, `sleep_contributor_<name>` (score: `deep_sleep`, `efficiency`, `latency`, `rem_sleep`, `restfulness`, `timing`, `total_sleep`) | UTC midnight of the day label | — |
| Readiness | `readiness_score`, `readiness_contributor_<name>` (score: `activity_balance`, `body_temperature`, `hrv_balance`, `previous_day_activity`, `previous_night`, `recovery_index`, `resting_heart_rate`, `sleep_balance`, `sleep_regularity`), `skin_temperature_deviation`, `skin_temperature_trend_deviation` (celsius; difference from the person's baseline, not body temperature) | UTC midnight of the day label | — |
| Oxygen | `oxygen_saturation` (percent, nightly average), `breathing_disturbance_index` (score) | UTC midnight | — |
| Stress / resilience | `stress_high_time`, `recovery_high_time` (s), `stress_day_summary` (level: 1 restored, 2 normal, 3 stressful), `resilience_level` (level: 1 limited … 5 exceptional), `resilience_contributor_<name>` (score) | UTC midnight | the summary/level word |
| Heart health | `cardiovascular_age` (years), `pulse_wave_velocity` (m/s), `vo2_max` (ml_kg_min) | UTC midnight / test time | — |
| Sleep session | `sleep_total_duration`, `sleep_deep_duration`, `sleep_light_duration`, `sleep_rem_duration`, `sleep_awake_time`, `sleep_time_in_bed`, `sleep_latency` (s), `sleep_efficiency` (percent), `sleep_respiratory_rate` (breaths/min), `sleep_average_heart_rate`, `sleep_lowest_heart_rate` (bpm), `sleep_average_hrv` (ms), `sleep_restless_periods` (count), `sleep_score_delta`, `readiness_score_delta` (score) | bedtime start | sleep type (`long_sleep`, `sleep`, `late_nap`, …) |
| | `sleep_stage` (stage; **1 deep, 2 light, 3 REM, 4 awake**), every 5 min | each 5 minutes from bedtime start | sleep type |
| | `sleep_movement` (level; 1 = no motion … 4 = restless), every 30 s | each 30 s | sleep type |
| Bedtime advice | `optimal_bedtime_start_offset`, `optimal_bedtime_end_offset` (s from midnight in the person's zone) | UTC midnight | Oura's recommendation/status word |
| Workouts | `workout_duration` (s), `workout_calories` (kcal), `workout_distance` (meters), `workout_intensity` (level: 1 easy, 2 moderate, 3 hard) | workout start | activity name |
| Sessions (meditation, breathing…) | `session_duration` (s), `session_heart_rate` (bpm), `session_hrv` (ms), `session_motion_count` (count) | start / each sample | session type |
| Device | `ring_battery_level` (percent) | each sample | `charging`, `in_charger`, or NULL |
| Body (snapshot) | `weight` (kg), `height` (cm) | **sync time** when it changed | — |

Whoop metrics:

| Group | `metric_type` (unit) | Timestamp anchor | `context` |
|---|---|---|---|
| Cycle (Whoop's physiological day) | `strain` (Whoop strain, 0–21 scale *[Inference]*), `total_energy` (kcal, converted from kJ), `average_heart_rate`, `max_heart_rate` (bpm), `steps` (count) | cycle start | — |
| Recovery | `recovery_score` (percent), `resting_heart_rate` (bpm), `heart_rate_variability_rmssd` (ms), `oxygen_saturation` (percent), `skin_temperature` (celsius, **absolute** skin temperature) | recovery `created_at` | `calibrating` if Whoop is still calibrating |
| Sleep | `sleep_total_duration` (light+deep+REM), `sleep_deep_duration` (Whoop "slow wave"), `sleep_light_duration`, `sleep_rem_duration`, `sleep_awake_time`, `sleep_time_in_bed`, `sleep_no_data_time`, `sleep_need_baseline`, `sleep_need_from_sleep_debt`, `sleep_need_from_recent_strain`, `sleep_need_from_recent_nap` (s, converted from ms), `sleep_cycle_count`, `sleep_disturbance_count` (count), `sleep_respiratory_rate` (breaths/min), `sleep_performance`, `sleep_consistency`, `sleep_efficiency` (percent) | sleep start | `nap` or `sleep` |
| Workout | `workout_duration` (s), `workout_strain`, `workout_average_heart_rate`, `workout_max_heart_rate` (bpm), `workout_calories` (kcal), `workout_distance`, `workout_altitude_gain`, `workout_altitude_change` (meters), `workout_percent_recorded` (percent), `workout_zone_0_duration` … `workout_zone_5_duration` (s, time in each heart-rate zone) | workout start | sport name |
| Body (snapshot) | `weight` (kg), `height` (cm), `max_heart_rate` (bpm) | sync time when changed | — |

Apple Health metrics: `heart_rate` (count/min), `respiratory_rate` (count/min), `oxygen_saturation` (%), `weight` (kg), `height` (cm), each at the measurement time **[Code]** **[DB Q11]**.

In the snapshot, Whoop readings exist only from the older backend: recovery and cycle metrics, without `context`. No Whoop documents are stored yet, because the Whoop login has needed reconnecting since before `wearables.records` existed **[DB Q27, Q18b]**.

### 4.4 Schema `labs`: lab PDF uploads

#### `labs.documents`

One row = one uploaded PDF file.

| Column | Type | Null? | Meaning / options |
|---|---|---|---|
| `id` | bigint | no | Primary key |
| `sha256` | text | no, unique | Fingerprint of the file |
| `filename` | text | no | Name as uploaded |
| `file_path` | text | no | Local path of the stored copy |
| `size_bytes` | bigint | no | File size |
| `page_count` | int | yes | Pages read |
| `extraction_method` | text | yes | Options (code): `text` (text layer), `ocr` (recognized from image), `mixed` |
| `collected_date` | date | yes | When the sample was taken: guessed from the PDF, then confirmed at review |
| `status` | text | no | **Enforced:** `processing`, `needs_review`, `reviewed`, `failed` |
| `error` | text | yes | Why reading failed |
| `uploaded_at` | timestamptz | no | Upload time |
| `reviewed_at` | timestamptz | yes | Last review time |

#### `labs.results`

One row = one result line read from a PDF.

| Column | Type | Null? | Meaning / options |
|---|---|---|---|
| `id` | bigint | no | Primary key |
| `document_id` | bigint | no | Foreign key → `labs.documents.id` (cascade delete) |
| `page`, `row_index` | int | no | Where in the PDF. `UNIQUE (document_id, page, row_index)` |
| `source_text` | text | no | The raw line of text, for checking |
| `analyte_name` | text | no | Test name as printed (or as corrected by the user). An **analyte** is the substance measured |
| `analyte_key` | text | yes | AyuOS's stable short name for the test (e.g. (synthetic) `glucose`), from a built-in dictionary **[Code `transform/lab-analytes.ts`]**. NULL if not recognized |
| `loinc_code` | text | yes | **Suggested** LOINC code from the same dictionary. NULL where the name is ambiguous. The code says it "is not authoritative" **[Code comment `transform/lab-analytes.ts`]** |
| `value_num` | double | yes | Numeric value |
| `value_text` | text | yes | Non-numeric result (e.g. (synthetic) "Negative") |
| `comparator` | text | yes | Options (code): `<`, `>`, `<=`, `>=`, `≤`, `≥` (the value is a limit, not exact) |
| `unit` | text | yes | Unit as printed |
| `ref_low`, `ref_high` | double | yes | Reference (normal) range bounds |
| `ref_text` | text | yes | Range as printed |
| `flag` | text | yes | Options (code): `H` high, `L` low, `A` abnormal/critical (any other printed marker), NULL. If the PDF printed no flag, it is inferred from the range **[Code `normalizeFlag`, `inferFlag`]** |
| `confidence` | real | no | Parser confidence, 0.5–1.0 (see §3.4). Not updated by review |
| `collected_date` | date | yes | Sample date. At review it is set to the document's date for all rows |
| `status` | text | no (default `pending`) | **Enforced:** `pending`, `confirmed`, `rejected` |
| `reviewed_at` | timestamptz | yes | When reviewed |

Partial index `lab_results_analyte_idx` on `(analyte_key, collected_date)` **only for confirmed rows**.

### 4.5 Schema `ops`: app bookkeeping

| Table | One row = | Columns |
|---|---|---|
| `ops.ehr_connections` | one connected hospital | `slug` (text, **primary key**; used as `source` everywhere), `display_name` (text, not null), `fhir_base_url` (text, not null, unique), `sandbox` (bool, not null, default false; **true = Epic's test server with fictional patients**), `created_at` |
| `ops.wearable_connections` | one wearable login | `provider` (primary key; `oura`/`whoop`), `access_token_enc`, `refresh_token_enc` (encrypted with a Keychain key, AES-256-GCM **[Code `shared/crypto.ts`]**), `token_expires_at`, `scope`, `provider_user_id`, `status` (**enforced:** `active`, `needs_reconnect`), `connected_at`, `last_synced_at` (last fully successful sync), `last_error` |
| `ops.wearable_sync_state` | one resume point per provider data type (snapshot types have none **[DB Q17]**) | `provider`, `data_type` (primary key together), `last_synced_at` (not null) |
| `ops.sync_runs` | one attempt of one job | `id`, `job` (text; code values: `wearables-oura`, `wearables-whoop`, `ehr-import:<slug>`, `lab-pdf-upload`, `apple-health-upload`; retired: `wearables-mirror`, `wearables-provider-pull` **[Code `load/sync-runs.ts`]** **[DB Q18]**), `trigger` (code: `manual`, `schedule`, `wake`, `connect`), `status` (**enforced:** `running`, `success`, `failed`), `started_at`, `finished_at`, `detail` (jsonb: e.g. counts per metric/type, `skipped` list), `error` |

Secrets: tokens are encrypted, but the database file itself is not encrypted. It relies on the Mac's disk encryption (FileVault) **[Code `shared/data-protection.ts`]**. An agent never needs to read `ops.wearable_connections` token columns.

---

## 5. How the tables relate, and tested joins

### 5.1 Map

```
ops.ehr_connections.slug ─(text match, not enforced)─► clinical.*.source
                                                       clinical.fhir_attachments.source

clinical.fhir_resources.id ◄─FK─ clinical.<typed>.fhir_resource_id        (enforced)
clinical.<typed>.id        ◄─FK─ clinical.<typed>_coding.<typed>_id       (enforced, cascade)
clinical.patient.id        ◄─FK─ clinical.patient_identifier.patient_id   (enforced, cascade)

FHIR links between records (all text, NOT enforced; match on source + resource_id):
  observation.patient_id / condition.patient_id / ...  → patient.resource_id          (bare id)
  observation.encounter_id, condition.encounter_id ... → encounter.resource_id        (bare id)
  document_reference.encounter_ids[]                   → encounter.resource_id        (bare ids)
  diagnostic_report.result_observation_ids[]           → observation.resource_id      (bare ids)
  procedure.report_diagnostic_report_ids[]             → diagnostic_report.resource_id (bare ids)
  observation.has_member_refs[]                        → 'Observation/<resource_id>'  (full refs)
  fhir_attachments (source, resource_type, resource_id)→ fhir_resources / document_reference / diagnostic_report

labs.documents.id ◄─FK─ labs.results.document_id                          (enforced, cascade)

wearables.records (provider, data_type, record_id) — no links to other tables
timeseries.readings (user_id, metric_type, ts, source_provider) — no links to other tables
ops.wearable_connections.provider ─(text match)─► readings.source_provider, records.provider
```

**[DB Q5]** for the enforced keys; **[Code `transform/*.ts`]** for the text links.

The only **enforced** links (foreign keys) are: typed table → raw version, child → parent, and lab result → lab document. **Every link between clinical records is plain text that nobody checks.** In the snapshot, most of those links point to records that are not in the database:

- 249 of 250 observation→encounter links have no matching encounter;
- 3 of 5 report→observation links have no match **[DB Q23]**.

Always use `LEFT JOIN` for them.

**There is no link between the three worlds** (clinical, labs, wearables) except time and the meaning of codes. A lab value from a PDF and the same test from a hospital are not linked; they can only be matched by LOINC code or name (see E9).

### 5.2 Key matching rules

| You want to join | Match on | Why |
|---|---|---|
| typed row → its raw JSON | `f.id = t.fhir_resource_id` | Enforced foreign key; always points to the current version **[DB Q23: 0 pointing to old versions]** |
| record → record (FHIR link) | `a.source = b.source AND b.resource_id = a.<link>` | Ids are unique only within a source (hospital) |
| link stored as full reference (`*_refs`, `medication_ref`, `requester_ref`) | `'Observation/' \|\| b.resource_id = ANY(a.has_member_refs)`, or strip the prefix with `split_part(ref,'/',2)` | These keep the `Type/id` form **[DB Q22]** |
| attachment → its document | `a.source = d.source AND a.resource_type = 'DocumentReference' AND a.resource_id = d.resource_id` | No foreign key |

### 5.3 Tested example queries

Each query below was executed against the live database in a read-only session before this document was finished. Values like `'synthetic-…'` are placeholders: replace them, or the query returns no rows.

**E1. Current raw records of one type, real hospitals only.**

```sql
-- E1
SELECT f.source, f.resource_id, f.json
FROM clinical.fhir_resources f
JOIN ops.ehr_connections c ON c.slug = f.source
WHERE f.is_current
  AND f.resource_type = 'Goal'
  AND NOT c.sandbox
```

**E2. Lab observations from hospitals with their LOINC code and numeric value, newest first.**

```sql
-- E2
SELECT o.source, o.resource_id, cc.code AS loinc, cc.display,
       o.value_quantity_value, o.value_quantity_unit, o.effective_datetime
FROM clinical.observation o
JOIN clinical.observation_code_coding cc
  ON cc.observation_id = o.id AND cc.system = 'http://loinc.org'
WHERE o.category_codes && ARRAY['laboratory', 'Lab', 'LAB']
  AND o.status NOT IN ('entered-in-error', 'cancelled')
ORDER BY o.effective_datetime DESC NULLS LAST
```

**E3. Observation → its visit (left join, because most links don't resolve).**

```sql
-- E3
SELECT o.resource_id, o.effective_datetime, e.period_start, e.class_display, e.type_text
FROM clinical.observation o
LEFT JOIN clinical.encounter e
  ON e.source = o.source AND e.resource_id = o.encounter_id
```

**E4. Diagnostic report → the observations it contains.**

```sql
-- E4
SELECT d.resource_id AS report_id, d.issued, o.resource_id AS observation_id,
       o.value_quantity_value, o.value_quantity_unit
FROM clinical.diagnostic_report d
LEFT JOIN clinical.observation o
  ON o.source = d.source AND o.resource_id = ANY (d.result_observation_ids)
```

**E5. Typed row → the full raw JSON (for fields the typed table doesn't have).**

```sql
-- E5
SELECT c.code_text, c.clinical_status, f.json -> 'note' AS notes, f.json -> 'severity' AS severity
FROM clinical.condition c
JOIN clinical.fhir_resources f ON f.id = c.fhir_resource_id
```

**E6. Version history of one record (what changed and when).**

```sql
-- E6
SELECT version, is_current, fetched_at, content_hash
FROM clinical.fhir_resources
WHERE source = 'synthetic-hospital' AND resource_type = 'Condition' AND resource_id = 'synthetic-123'
ORDER BY version
```

**E7. Clinical notes and their downloaded files.**

```sql
-- E7
SELECT d.resource_id, d.date, a.title, a.content_type, a.file_path, a.error
FROM clinical.document_reference d
JOIN clinical.fhir_attachments a
  ON a.source = d.source AND a.resource_type = 'DocumentReference' AND a.resource_id = d.resource_id
ORDER BY d.date DESC NULLS LAST
```

**E8. Multi-part observations (e.g. blood pressure), which exist only in raw JSON.**

```sql
-- E8
SELECT f.resource_id,
       f.json #>> '{effectiveDateTime}' AS measured_at,
       comp #>> '{code,coding,0,code}' AS component_code,
       comp #>> '{code,coding,0,display}' AS component_name,
       (comp #>> '{valueQuantity,value}')::float AS value,
       comp #>> '{valueQuantity,unit}' AS unit
FROM clinical.fhir_resources f
CROSS JOIN LATERAL jsonb_array_elements(f.json -> 'component') AS comp
WHERE f.resource_type = 'Observation' AND f.is_current AND f.json ? 'component'
```

**E9. One lab-result list from both hospitals and confirmed PDF results** (the same pattern the app's record page uses **[Code `app/record.ts`]**).

```sql
-- E9
WITH ehr AS (
  SELECT 'hospital' AS origin, cc.code AS loinc, cc.display AS name,
         o.value_quantity_value AS value, o.value_quantity_unit AS unit, o.effective_datetime AS at
  FROM clinical.observation o
  JOIN clinical.observation_code_coding cc
    ON cc.observation_id = o.id AND cc.system = 'http://loinc.org'
  WHERE o.category_codes && ARRAY['laboratory', 'Lab', 'LAB']
),
pdf AS (
  SELECT 'lab_pdf' AS origin, r.loinc_code AS loinc, r.analyte_name AS name,
         r.value_num AS value, r.unit, r.collected_date::timestamptz AS at
  FROM labs.results r
  WHERE r.status = 'confirmed'
)
SELECT * FROM ehr UNION ALL SELECT * FROM pdf
ORDER BY loinc NULLS LAST, at DESC NULLS LAST
```

**E10. Daily average of a continuous metric, by the person's local day.**

```sql
-- E10
SELECT (ts AT TIME ZONE 'America/New_York')::date AS local_day,
       source_provider, avg(value) AS avg_value, count(*) AS samples
FROM timeseries.readings
WHERE metric_type = 'heart_rate'
  AND ts >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1, 2
```

(`America/New_York` is a synthetic choice. Use the person's real zone; see trap T5.)

**E11. A daily score by the provider's own day label** (correct for any time zone).

```sql
-- E11
SELECT day, (json ->> 'score')::int AS sleep_score, json -> 'contributors' AS contributors
FROM wearables.records
WHERE provider = 'oura' AND data_type = 'daily_sleep' AND is_current
  AND day >= current_date - 30
ORDER BY day
```

**E12. Main sleep per night, excluding naps, with local bedtime.**

```sql
-- E12
SELECT day, sleep_type, total_sleep_s / 3600.0 AS hours, efficiency_pct,
       json ->> 'bedtime_start' AS bedtime_start_local
FROM wearables.oura_sleep
WHERE sleep_type = 'long_sleep'
ORDER BY day DESC
```

**E13. Hourly heart rate during workouts only (uses `context`).**

```sql
-- E13
SELECT date_trunc('hour', ts) AS hour_utc, avg(value) AS avg_bpm
FROM timeseries.readings
WHERE metric_type = 'heart_rate' AND source_provider = 'oura' AND context = 'workout'
GROUP BY 1
ORDER BY 1 DESC
```

**E14. How fresh is each source?** (Check this before answering "latest" questions.)

```sql
-- E14
SELECT r.source_provider, max(r.ts) AS newest_reading,
       w.status AS login_status, w.last_synced_at, w.last_error
FROM timeseries.readings r
LEFT JOIN ops.wearable_connections w ON w.provider = r.source_provider
GROUP BY r.source_provider, w.status, w.last_synced_at, w.last_error
```

**E15. Last import of each hospital and whether it is a sandbox.**

```sql
-- E15
SELECT c.slug, c.display_name, c.sandbox,
       (SELECT max(started_at) FROM ops.sync_runs s
        WHERE s.job = 'ehr-import:' || c.slug AND s.status = 'success') AS last_successful_import
FROM ops.ehr_connections c
```

**E16. Active problem list** (diagnoses not resolved or refuted).

```sql
-- E16
SELECT c.source, c.code_text, c.clinical_status, c.verification_status, c.onset_text, c.category_codes,
       array_agg(cc.system || '|' || cc.code) AS codes
FROM clinical.condition c
LEFT JOIN clinical.condition_coding cc ON cc.condition_id = c.id
WHERE coalesce(c.clinical_status, 'unknown') NOT IN ('resolved', 'inactive', 'remission')
  AND coalesce(c.verification_status, 'unknown') NOT IN ('refuted', 'entered-in-error')
GROUP BY c.id
```

---

## 6. Conventions

### 6.1 Naming

- Schemas are named by kind of data (`clinical`, `timeseries`, `wearables`, `labs`, `ops`). Tables and columns are `snake_case` **[DB Q2, Q4]**.
- Typed clinical tables are named after the FHIR type in snake_case (`DiagnosticReport` → `diagnostic_report`). Child tables append the FHIR field (`_coding`, `_type_coding`, `_vaccine_coding`, `_content`, `_presented_form`, `_identifier`) **[DB Q2]**.
- Suffixes: `_id` = a single bare id; `_ids` = array of bare ids; `_refs`/`_ref` = full `Type/id` references; `_text` = human-readable text; `_code`/`_system`/`_display` = a coding split into three columns; `_enc` = encrypted **[DB Q22]** **[Code]**.
- `id` is always AyuOS's own number. `resource_id` / `record_id` is the source's id **[Code]**.
- Readings metric names are `snake_case` with a group prefix (`sleep_`, `workout_`, `session_`, `*_contributor_`). The same concept uses the same name across providers where the meaning matches (e.g. `sleep_total_duration`) **[Code]**.

### 6.2 Partitioning

`timeseries.readings` is range-partitioned by `ts`, one partition per UTC calendar month, created by the app when a month first gets data **[Code `load/timeseries.ts`]** **[DB Q32]**. Partitioning is invisible to queries on the parent table; filtering on `ts` makes queries faster *[Inference]*.

### 6.3 Versioning

Two tables keep history: `clinical.fhir_resources` and `wearables.records`. Pattern **[Code `load/raw-store.ts`, `load/wearable-records.ts`]**:
- `content_hash` = SHA-256 of the JSON text;
- same hash → no write; different hash → old row `is_current = false`, new row `version = old + 1`;
- a partial unique index guarantees one current row per identity **[DB Q6]**.

Everything else is current-state only.

### 6.4 Dates and times

- **Storage:** all instants are `timestamptz` (a moment in time, stored as UTC and shown in the session's zone, which is UTC here). Calendar dates without time are `date` (`birth_date`, `labs.*.collected_date`, `wearables.records.day`) **[DB Q1, Q4]**.
- **Local time is not stored** in any column. Oura and Whoop local offsets survive only inside `wearables.records.json` (`bedtime_start`, `timestamp`, `timezone_offset`) **[DB Q31]**. Hospital JSON keeps the original strings.
- **Partial FHIR dates** (`2019`, `2019-05`): Condition, MedicationRequest, AllergyIntolerance and Encounter store a padded timestamp (`2019` → 2019-01-01T00:00Z) and, for onset/abatement, the original text in `*_text` **[Code `transform/fhir-helpers.ts` `fhirInstant`]**. The 0002-era tables (observation, diagnostic_report, document_reference, procedure, immunization) store the source value as-is. *[Inference]* A partial date there would be read by Postgres's own parser or rejected; I didn't test which.
- **Date-only FHIR values** are pinned to midnight UTC **[Code `fhirInstant`]**.
- **Daily wearable values** in `readings` are anchored differently by type **[DB Q15]** **[Code]**:
  - most Oura daily metrics (sleep, readiness, SpO₂, stress, contributors, cardiovascular age) sit at **00:00 UTC of Oura's day label**;
  - Oura **activity** metrics sit at Oura's activity-day timestamp (the local start of the activity day, converted to UTC);
  - Whoop metrics sit at the cycle/sleep/workout start or the recovery creation time.

  Use `wearables.records.day` for "which day" questions (trap T5).
- **Durations** are seconds (`s`) in `readings`, for both providers (Whoop milliseconds are converted) **[Code]**.

### 6.5 Medical codes

A coded concept is stored as `(system, code, display)`. Systems are URIs **[DB Q21]**:

| System URI (observed) | Vocabulary |
|---|---|
| `http://loinc.org` | **LOINC**: lab tests, vital signs, document types |
| `http://snomed.info/sct` | **SNOMED CT**: clinical terms (diagnoses, findings, allergens) |
| `http://hl7.org/fhir/sid/icd-10-cm`, `…/icd-9-cm` | **ICD-10-CM / ICD-9-CM**: diagnosis billing codes |
| `http://www.ama-assn.org/go/cpt` | **CPT**: procedure codes |
| `http://hl7.org/fhir/sid/cvx` | **CVX**: vaccine codes |
| `http://hl7.org/fhir/sid/ndc` | **NDC**: drug product codes |
| `urn:oid:1.2.840.114350…` | **Epic's own** local code lists (an **OID** is a dotted numeric identifier) |
| `http://open.epic.com/FHIR/StructureDefinition/observation-flowsheet-id` | Epic **flowsheet** row ids (Epic's internal measurement ids) |
| `urn:oid:1.2.246.537.6.96` | *[Unknown]* (an OID-based list seen on observations) |

- One concept often has codings from several systems; for observations it averages ~6 **[DB Q21b]**. To identify a lab test, prefer `system = 'http://loinc.org'`.
- `category_codes` arrays keep only the code strings, dropping the system **[Code `categoryCodes`]**.
- Lab PDFs use `analyte_key` (AyuOS's own key) and a suggested `loinc_code` **[Code]**.

### 6.6 Units

- Clinical units are free text as sent by the hospital, plus a separate unit code (`value_quantity_code`) when given **[Code]**.
- Wearable units are labels chosen by AyuOS's mapping code, not a standard. The same quantity can be written differently: `bpm` vs `count/min`, `percent` vs `%` **[DB Q25]**.
- Energy is kcal everywhere in `readings`; Whoop kJ is divided by 4.184 **[Code]**.
- Lab PDF units are as printed **[Code]**.

---

## 7. Traps that cause wrong answers

| # | Trap | Evidence | What to do |
|---|---|---|---|
| **T1** | **Test data looks like real data.** Rows from Epic's **sandbox** (fictional test patients) sit in the same tables as real records, distinguished only by `source`. In the snapshot, *all* hospital data is sandbox data | **[DB Q8, Q10]** | Join `ops.ehr_connections` and exclude `sandbox = true` unless the user explicitly wants test data (E1) |
| **T2** | **Old versions in the raw store.** `fhir_resources` and `wearables.records` keep every version; some records have 2 versions | **[DB Q8, Q16]** | Always filter `is_current` (or use the typed tables) |
| **T3** | **Unconfirmed lab values.** `labs.results` holds `pending` (machine guesses, never checked) and `rejected` (known wrong) rows | **[Code, DB Q19]** | Use only `status = 'confirmed'` |
| **T4** | **Double counting across sources.** The same quantity can come from several providers: `heart_rate` from Oura and Apple Health on the same days, `oxygen_saturation` from all three, `weight`/`height` from two or three. *[Inference]* Apple Health may itself contain data copied from the ring | **[DB Q25, Q26]** | Pick one `source_provider` per question, or report sources separately; never average across them silently |
| **T5** | **Shifted days.** Many daily Oura values are stamped 00:00 UTC of their day. Converting to a zone west of UTC moves them to the *previous* day. Activity values are stamped at a local-time instant, so their UTC date can be the previous day for zones east of UTC | **[DB Q15]** **[Code]** | For daily values, use `wearables.records.day` (E11), or `(ts AT TIME ZONE 'UTC')::date` for the UTC-midnight metrics. Use the person's local zone only for continuous samples (E10) |
| **T6** | **Same name, different meaning.** `heart_rate_variability_sdnn` (Oura) ≠ `heart_rate_variability_rmssd` (Whoop) are different formulas. `skin_temperature_deviation` (Oura: difference from baseline, °C) ≠ `skin_temperature` (Whoop: absolute °C). `energy` = Oura **active** kcal, `total_energy` = total kcal. `oxygen_saturation` (Oura) is a nightly average, while Apple's are spot readings. Oura `sleep_efficiency` and Whoop `sleep_efficiency` are each provider's own formula | **[Code `oura.ts`, `whoop.ts`]** | Never compare or merge these across providers without saying so |
| **T7** | **Scores are provider-specific.** `sleep_score`, `readiness_score`, `activity_score`, `recovery_score`, `strain`, contributors and `*_level` values are proprietary 0–100 (or ordinal) scores, not medical measurements | **[Code]** | Present them as "Oura's/Whoop's score", not as clinical facts |
| **T8** | **Ordinal codes stored as numbers.** `sleep_stage` (1 deep, 2 light, 3 REM, 4 awake), `activity_class` (0–5), `sleep_movement` (1–4), `stress_day_summary`, `resilience_level`, `workout_intensity` are labels, not quantities | **[Code]** | Count or group them; never average them |
| **T9** | **Snapshot timestamps are sync times.** `weight`, `height` and Whoop `max_heart_rate` readings from Oura/Whoop are stamped when AyuOS *noticed* a change, not when the person was weighed | **[Code `changedSnapshots`]** | Say "recorded by <provider> as of …" |
| **T10** | **Missing values look like normal values.** 93 of 252 observations have no structured value; 90 of them carry their values in `component` (e.g. blood pressure), which the typed table ignores. Reference ranges and high/low flags from hospitals aren't in the typed table either | **[DB Q20, Q24]** **[Code `transform/observation.ts`]** | When `value_*` is all NULL, read `fhir_resources.json` (E8) |
| **T11** | **Links that point nowhere.** Clinical links are unenforced text and often don't resolve (249/250 observation→encounter, 3/5 report→result) | **[DB Q23]** | `LEFT JOIN`; never conclude "no visit" or "no results" from a failed join |
| **T12** | **Bare ids vs full references.** `patient_id`, `encounter_id`, `*_ids` are bare (`abc`); `*_refs`, `medication_ref`, `requester_ref`, `service_provider_ref` are full (`Practitioner/abc`) | **[DB Q22]** | Use the matching join form (§5.2) |
| **T13** | **Ids are only unique per source.** Two hospitals can use the same `resource_id` or `patient_id` | **[Code: `UNIQUE (source, resource_id)`]** | Always join on `source` too |
| **T14** | **Unused columns.** `fhir_resources.date_low/date_high/date_sort` are always NULL; `readings.source_device` is always NULL | **[DB Q9, Q13]** | Ignore them; take dates from typed tables or JSON |
| **T15** | **`context` is NULL for older readings.** All readings written before 2026-10-22 (the bulk of heart-rate history) have no `context`, and some newer heart-rate rows don't either, so filtering on `context = 'sleep'` silently drops them | **[DB Q14]** | Treat NULL as "unknown", not as "awake" or "not sleep". For sleep-time heart rate in older data, join to sleep periods by time |
| **T16** | **Stale data looks current.** A dead login (`needs_reconnect`) stops new data, but old rows remain. In the snapshot, the Whoop login needs reconnecting and Whoop has no stored documents | **[DB Q18b, Q27]** | Check freshness (E14) before answering "latest" or "recent" |
| **T17** | **Several sleeps per day.** Oura records naps and main sleep separately (up to 4 per day seen) | **[DB Q34]** | Use `sleep_type = 'long_sleep'` for "last night", or sum deliberately |
| **T18** | **Records never disappear.** Records the hospital deleted, and the hospital's cancelled or "entered-in-error" statuses, stay in the database | **[Code: no delete paths]** | Filter out statuses `entered-in-error`, `cancelled`, `refuted`; and treat old imports as "as of the import date" (E15) |
| **T19** | **Prescriptions ≠ medications taken.** `medication_request` rows are orders; `status = 'active'` means the order is active at the hospital as of the last import | **[Code]** | Say "prescribed", not "takes" |
| **T20** | **Panels and members.** A panel observation (`has_member_refs`) and its member observations are separate rows | **[DB Q22]** | Don't count a panel and its members as separate tests |
| **T21** | **Mixed category spellings.** Category codes from Epic mix standard and local forms (`laboratory`/`Lab`/`LAB`, `Imaging`/`imaging`) | **[DB Q30]** | Match several spellings, or use LOINC codes instead of categories |
| **T22** | **Lab PDF codes are suggestions.** `labs.results.loinc_code` comes from a built-in dictionary and can be NULL or not exact; `analyte_key` is AyuOS-specific | **[Code `lab-analytes.ts`]** | Match PDF and hospital labs by LOINC *and* name, and say when the match is uncertain |
| **T23** | **Lab dates are document-level.** All confirmed results of one PDF share the document's `collected_date` | **[Code `saveReview`]** **[DB Q19b]** | Don't infer separate sample times within one report |
| **T24** | **PII in several places.** Names, birth date, address, phone, email (`clinical.patient`, `patient_identifier`), and email/age/sex in Oura `personal_info` and Whoop `profile` JSON | **[Code]** | Don't output them unless asked |

---

## 8. What the design supports, cannot support, and is missing

### Supported well *[Inference from schema]*

- **"What is my latest/trend of X?"** for any wearable metric: one indexed table, any time range, by provider (`timeseries.readings`).
- **Sleep questions:** durations, stages over the night (`sleep_stage`), efficiency, naps vs main sleep, scores and their contributors, bedtime advice.
- **Workouts:** per-workout duration, calories, distance, sport, heart-rate zones (Whoop), intensity (Oura).
- **Hospital history as of the last import:** problem list, visit list, prescriptions, allergies, vaccines, procedures, lab and vital-sign values (by LOINC), clinical notes (as files).
- **Lab trends** across hospital and confirmed PDF results by LOINC code (E9).
- **Auditing:** what the source sent, exactly (`json`), and how a record changed (`version`).
- **Freshness/coverage questions:** "when did Oura last sync?" (`ops.*`).

### Not supported, or only with extra work

| Need | Why not | Source |
|---|---|---|
| Multiple people | Single user per install; `user_id` exists only on readings | **[Code]** |
| Up-to-date hospital data | One-time download per login; no refresh in the background | **[Code]** |
| Hospital reference ranges, interpretation flags, components, notes, `valueString` | Not in typed tables; JSON only | **[Code `transform/observation.ts`]** |
| CarePlan, CareTeam, Device, FamilyMemberHistory, Goal, MedicationStatement, QuestionnaireResponse, ServiceRequest, Specimen | No typed table; JSON only | **[Code `transform/run.ts`]** |
| Text of clinical notes | Stored as files on disk (HTML/XML/RTF), not as text columns | **[Code `load/attachment-store.ts`]** |
| Whether a medication was actually taken | Only orders are stored (MedicationStatement is raw-only) | **[Code]** |
| Local time of continuous readings | Offsets are not stored with readings | **[DB Q4]** |
| Telling deleted hospital records from current ones | No delete detection | **[Code]** |
| Standard units across providers | Units are free-text labels | **[DB Q25]** |
| Linking a wearable reading to a hospital visit | No shared keys; only time | **[DB Q5]** |
| Device identity for readings | `source_device` never filled | **[DB Q13]** |
| Oura resilience and tags | Not stored until the user re-grants permissions (`stress`, `tag`) | **[DB Q16; Code `providers.ts`]** |

### Missing (things an agent will want that don't exist)

- A per-person **time zone** setting (needed for "today", "last night") *[Inference]*.
- **Medication list normalization** (RxNorm codes for Epic's referenced medications) **[DB Q8b]**.
- A **unified lab-results view** across hospital and PDF sources (E9 approximates it) *[Inference]*.
- **Units normalization** and a **metric dictionary table** (the catalog in §4.3 lives only in code) *[Inference]*.
- **Data-quality flags** on readings (e.g. ring not worn) other than `non_wear_time` *[Inference]*.
- **Text extraction** of clinical note files *[Inference]*.

---

## 9. Rules for any agent reading this data

1. **Read only.** Connect with a read-only session (`SET default_transaction_read_only = on`), or a read-only database role. Never write; the app owns all writes.
2. **Current versions only:** filter `is_current` on `clinical.fhir_resources` and `wearables.records`, or use typed tables and views.
3. **Exclude sandbox sources** (`ops.ehr_connections.sandbox = true`) unless the user asks about test data. If *all* hospital data is sandbox, say there is no real hospital data.
4. **Lab PDFs: `status = 'confirmed'` only.**
5. **Join FHIR links on `source` and the id**, with `LEFT JOIN`. Use bare ids for `*_id`/`*_ids`, and full `Type/id` for `*_ref`/`*_refs`.
6. **One provider per metric per answer**, or show them side by side. Name the provider ("Oura's sleep score"). Never merge SDNN with RMSSD, or Oura's baseline deviation with Whoop's absolute skin temperature.
7. **Days:** use `wearables.records.day` for daily wearable values. Convert continuous `ts` to the user's time zone; ask for it if you don't know it, and never assume UTC is local.
8. **Check freshness** (E14, E15) and say "as of <date>" for hospital data and for any provider whose login is `needs_reconnect`.
9. **When a typed column is NULL, look in `json`** before saying "no value" (components, reference ranges, interpretation, notes).
10. **Don't average ordinal codes** (`sleep_stage`, `activity_class`, `*_level`, `workout_intensity`).
11. **Exclude statuses** `entered-in-error`, `cancelled` (and `refuted` for conditions). Treat `medication_request` as prescribed, not taken.
12. **Treat provider scores as the provider's opinion,** not diagnoses. Don't make medical diagnoses from this data; point the user to a clinician for decisions.
13. **Don't reveal PII** (`clinical.patient`, `patient_identifier`, Oura `personal_info`, Whoop `profile`) unless asked; never read `ops.wearable_connections` token columns.
14. **Cite where each answer came from:** table, provider/hospital, and date range, so the user can check.
15. **Query the parent `timeseries.readings`,** never a monthly partition. Always filter on `metric_type` and a `ts` range: it holds millions of rows, about 97% of them dense per-sample series **[DB Q33]**.

---

## 10. Cheat sheet (paste into a prompt)

> **AyuOS DB: one person's health data, local PostgreSQL 17 (UTC). READ ONLY.**
>
> **Where things are**
> - Hospital (Epic/FHIR) raw: `clinical.fhir_resources(source, resource_type, resource_id, version, is_current, json, patient_id, fetched_at)`. Filter `is_current`.
> - Hospital typed (current state; key `(source, resource_id)`; raw via `fhir_resource_id`):
>   - `clinical.observation`: labs/vitals; values `value_quantity_value/unit`, `value_text`, `value_code`; time `effective_datetime`; codes in `observation_code_coding(system, code, display)`, LOINC = `http://loinc.org`.
>   - `clinical.condition`: diagnoses; `clinical_status`, `verification_status`, `code_text`, `onset_*`.
>   - `clinical.encounter`: visits; `period_start/end`.
>   - `clinical.medication_request`: prescriptions; `medication_text`, `dosage_text`, `status`.
>   - `clinical.allergy_intolerance`, `clinical.immunization`, `clinical.procedure`.
>   - `clinical.diagnostic_report`: `result_observation_ids[]`.
>   - `clinical.document_reference` (notes; files in `clinical.fhir_attachments`).
>   - `clinical.patient`: PII.
>   - Each has `*_coding` children.
> - Wearables numbers: `timeseries.readings(user_id, metric_type, ts, value, unit, source_provider ∈ {oura, whoop, apple_health}, context)`. Key `(user_id, metric_type, ts, source_provider)`. Partitioned by month; query the parent with a `ts` range.
> - Wearables documents: `wearables.records(provider, data_type, record_id, day, start_time, end_time, json, is_current)`. Views: `wearables.oura_sleep`, `wearables.whoop_sleep`, `wearables.workouts`.
> - Lab PDFs: `labs.results(analyte_name, analyte_key, loinc_code, value_num, value_text, comparator, unit, ref_low, ref_high, flag ∈ {H, L, A}, collected_date, status)` → **use `status = 'confirmed'` only**. Parent: `labs.documents`.
> - Bookkeeping:
>   - `ops.ehr_connections(slug = source, sandbox)`;
>   - `ops.wearable_connections(provider, status ∈ {active, needs_reconnect}, last_synced_at)`;
>   - `ops.sync_runs(job, status, started_at, error)`.
>
> **Must-do rules**
> 1. `is_current` on raw tables.
> 2. Exclude `source` where `ops.ehr_connections.sandbox` (Epic test patients).
> 3. Labs: confirmed only.
> 4. Join FHIR links on `source` + id with `LEFT JOIN`. `*_id`/`*_ids` = bare ids; `*_ref(s)` = `Type/id`. Links are often unresolved.
> 5. Don't mix providers: Oura HRV = SDNN, Whoop HRV = RMSSD; Oura `skin_temperature_deviation` (vs baseline) ≠ Whoop `skin_temperature` (absolute); `energy` = active kcal, `total_energy` = total kcal.
> 6. Daily Oura values: use `wearables.records.day`; many readings sit at 00:00 UTC (converting zones shifts the day). Continuous samples: convert `ts` to the user's zone.
> 7. Ordinals: don't average `sleep_stage` (1 deep, 2 light, 3 REM, 4 awake), `activity_class` (0–5), `sleep_movement` (1–4), `*_level`, `workout_intensity`.
> 8. `weight`/`height` from Oura/Whoop are stamped at sync time.
> 9. Observation with all `value_*` NULL → read `clinical.fhir_resources.json` (`component`, `referenceRange`, `interpretation`).
> 10. `context` NULL on older readings = unknown.
> 11. Several Oura sleeps per day: `sleep_type = 'long_sleep'` = main sleep.
> 12. Check freshness: `max(ts)` per provider and `ops.wearable_connections.status`. Hospital data is a one-time import: say "as of <last import>".
> 13. Ignore `fhir_resources.date_low/high/sort` and `readings.source_device` (always NULL).
> 14. Exclude statuses `entered-in-error`/`cancelled`/`refuted`. Prescriptions ≠ taken.
> 15. Scores (sleep/readiness/activity/recovery/strain) are provider scores, not diagnoses.
> 16. No PII output unless asked. Never read token columns.
> 17. Cite table, provider/hospital and date range in every answer.
>
> **Metric names (readings):**
> - Shared: `heart_rate`, `oxygen_saturation`, `weight`, `height`, `steps`, `total_energy`, `sleep_total_duration`, `sleep_deep_duration`, `sleep_light_duration`, `sleep_rem_duration`, `sleep_awake_time`, `sleep_time_in_bed`, `sleep_efficiency`, `sleep_respiratory_rate`, `workout_duration`, `workout_calories`, `workout_distance`.
> - Oura: `heart_rate_variability_sdnn`, `sleep_score`, `readiness_score`, `activity_score`, `*_contributor_*`, `skin_temperature_deviation`, `energy`, `met`, `activity_class`, `sleep_stage`, `sleep_movement`, `stress_high_time`, `resilience_level`, `cardiovascular_age`, `vo2_max`, `ring_battery_level`.
> - Whoop: `heart_rate_variability_rmssd`, `resting_heart_rate`, `recovery_score`, `strain`, `skin_temperature`, `sleep_performance`, `sleep_need_*`, `workout_strain`, `workout_zone_N_duration`.
> - Apple: `heart_rate`, `respiratory_rate`, `oxygen_saturation`, `weight`, `height`.
> - Durations are in seconds; energy in kcal.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **Activity class** | Oura's 5-minute label of how active the person was (0 non-wear to 5 high) |
| **AllergyIntolerance** | FHIR record of an allergy or intolerance to a substance |
| **Analyte** | The substance a lab test measures (e.g. glucose) |
| **Array column** (`text[]`) | A column holding a list of values; test membership with `'x' = ANY(col)` or overlap with `col && ARRAY[...]` |
| **Bundle** | A FHIR response containing a page of resources |
| **CarePlan / CareTeam / Goal / ServiceRequest / Specimen / Device / FamilyMemberHistory / MedicationStatement / QuestionnaireResponse** | Other FHIR record types: care plans, the care team, health goals, orders for tests/referrals, lab samples, medical devices, relatives' conditions, medications the patient reports taking, questionnaire answers |
| **CDA / C-CDA** | An older XML format for clinical documents; Apple Health's `export_cda.xml` uses it |
| **CHECK constraint** | A database rule limiting a column to certain values; "enforced" in this document |
| **Code system** | A standard list of medical codes (LOINC, SNOMED CT, …), identified by a URI |
| **Coding / CodeableConcept** | In FHIR, a *coding* is one `(system, code, display)`; a *CodeableConcept* is a concept with one or more codings plus optional text |
| **Component** | Part of a FHIR Observation that has several values (e.g. systolic and diastolic blood pressure) |
| **Condition** | FHIR record of a diagnosis, problem, or health concern |
| **Content hash / SHA-256** | A fixed-length fingerprint of data; identical data gives the identical hash |
| **Context** (readings) | AyuOS's qualifier on a reading: activity, sleep type, sport, etc. |
| **CPT** | Codes for medical procedures (American Medical Association) |
| **Cardiovascular age** | Oura's estimate of how old the heart and vessels "look", from pulse wave velocity |
| **CVX** | Codes for vaccines (US CDC) |
| **Deep / light / REM sleep** | Sleep stages. *Deep* (slow-wave) is the most restorative; *REM* (rapid eye movement) is when most dreaming occurs; *light* is everything else asleep |
| **DiagnosticReport** | FHIR record grouping results of a test (lab panel, imaging) and its conclusion |
| **DocumentReference** | FHIR record pointing to a clinical document (e.g. a visit note) |
| **EHR** | Electronic health record system used by a hospital (e.g. Epic) |
| **Embedded Postgres** | PostgreSQL run by the app itself as a local process |
| **Encounter** | FHIR record of a visit, admission, or other contact with care |
| **Epic / MyChart** | A major US hospital EHR vendor, and its patient portal used for login |
| **FHIR** | "Fast Healthcare Interoperability Resources": the standard JSON format hospitals use to exchange records. Each record is a *resource* with a `resourceType` and an `id` |
| **Flowsheet** | Epic's internal table of repeated measurements (e.g. vital signs); flowsheet ids are Epic-specific |
| **Foreign key (FK)** | A database rule that a column's value must exist in another table's key |
| **GIN index** | An index type that makes array/JSON searches fast |
| **Heart-rate zones** | Bands of heart rate relative to maximum (Whoop zones 0–5) |
| **HRV, SDNN, RMSSD** | *Heart rate variability*: variation between heartbeats. SDNN (Oura) and RMSSD (Whoop) are two different formulas; values are not interchangeable |
| **Hypnogram** | A chart of sleep stages over the night; here the 5-minute `sleep_stage` series |
| **ICD-9-CM / ICD-10-CM** | Diagnosis code lists used for billing (older and current US versions) |
| **Idempotent** | Safe to run more than once with the same result |
| **Immunization** | FHIR record of a vaccine given |
| **Index** | A database structure that makes lookups faster; a *unique* index also forbids duplicates; a *partial* index covers only rows matching a condition |
| **JSONB** | Postgres's binary JSON type; read fields with `->` (JSON) and `->>` (text), paths with `#>`/`#>>` |
| **Keychain** | macOS's encrypted password store |
| **LATERAL** | SQL that lets a subquery or function use columns of the row before it (used to expand JSON arrays) |
| **launchd agent** | A macOS background service that starts at login |
| **LOINC** | Standard codes for lab tests, measurements and document types |
| **MedicationRequest** | FHIR record of a prescription/order |
| **MET** | Metabolic equivalent: energy use relative to rest (1 MET = at rest); MET-minutes = METs × minutes |
| **Migration** | A file that creates or changes database structure |
| **NDC** | US National Drug Code for drug products |
| **NULL** | "No value"; not zero, not empty text |
| **OAuth / SMART on FHIR** | Standard login flows that give an app a token to read data; SMART on FHIR is the version used by hospital FHIR servers |
| **Observation** | FHIR record of one measurement or finding (lab value, vital sign, survey answer) |
| **OCR** | Optical character recognition: reading text from an image |
| **OID** (`urn:oid:…`) | A dotted-number identifier, used here for Epic's local code lists |
| **Ordinal** | A number that labels an ordered category; differences and averages are meaningless |
| **Panel** | A group test (e.g. a blood count) whose members are separate observations |
| **Partition** | A physical sub-table holding part of a big table (here, one month of readings) |
| **Patient** | FHIR record with the person's demographics |
| **PII** | Personally identifying information (name, birth date, address, email…) |
| **Primary key (PK)** | The column(s) that uniquely identify a row |
| **Procedure** | FHIR record of something done to the patient (surgery, test procedure) |
| **Pulse wave velocity** | Speed of the pressure wave through arteries; higher generally means stiffer arteries |
| **Readiness / recovery / strain** | Oura's readiness score and Whoop's recovery score: how prepared the body is, 0–100. Whoop strain: cardiovascular load, roughly 0–21 |
| **Reference** (FHIR) | A link to another resource, written `Type/id` |
| **Reference range** | The normal range for a lab test at the lab that ran it |
| **Resource** | One FHIR record |
| **Respiratory rate** | Breaths per minute |
| **Resting heart rate** | Lowest steady heart rate at rest, usually during sleep |
| **Sandbox** | Epic's test server with fictional patients |
| **Schema** | A named group of tables in a database |
| **SDOH** | Social determinants of health (housing, food security, etc.); an Observation category |
| **SNOMED CT** | A large standard vocabulary of clinical terms |
| **SpO₂ / oxygen saturation** | Percentage of blood hemoglobin carrying oxygen |
| **Skin temperature deviation** | Oura: difference from the person's own baseline temperature, in °C |
| **Timestamptz** | Postgres "timestamp with time zone": an absolute instant, stored in UTC |
| **Transaction** | A group of database changes that succeed or fail together |
| **UCUM** | Unified Code for Units of Measure, a standard way to write units |
| **Upsert** | Insert a row, or update it if one with the same key exists |
| **UTC** | Coordinated Universal Time, the reference time zone (no daylight saving) |
| **View** | A saved query that looks like a table |
| **Vital signs** | Basic body measurements: heart rate, blood pressure, temperature, breathing rate, oxygen, weight, height |
| **VO₂ max** | Estimated maximum oxygen uptake during exercise (ml per kg per minute): a fitness measure |

---

## Appendix A: evidence queries

All of these were run in a read-only session (`SET default_transaction_read_only = on`) on 2026-10-22, and run again before this document was finished. Results are summarized in the sections above; only metadata and counts are shown, never health values.

```sql
-- Q1: engine, time zone, size, location
SELECT version(), current_setting('TimeZone') AS tz,
       pg_size_pretty(pg_database_size(current_database())) AS size,
       current_setting('data_directory') AS data_dir
```

```sql
-- Q2: schemas, tables and views (top-level)
SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('clinical','timeseries','labs','ops','wearables')
  AND c.relkind IN ('r','p','v') AND NOT c.relispartition
ORDER BY 1, 2
```

```sql
-- Q3: monthly partitions of readings
SELECT count(*) AS partitions
FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
WHERE p.relname = 'readings'
```

```sql
-- Q4: every column, type, nullability, default
SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema IN ('clinical','timeseries','labs','ops','wearables')
  AND table_name NOT LIKE 'readings\_2%'
ORDER BY table_schema, table_name, ordinal_position
```

```sql
-- Q5: primary keys, foreign keys, unique and check constraints
SELECT conrelid::regclass AS table_name, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace::regnamespace::text IN ('clinical','timeseries','labs','ops','wearables')
  AND conrelid::regclass::text NOT LIKE 'timeseries.readings\_2%'
ORDER BY 1, 2
```

```sql
-- Q6: indexes (including partial unique "current version" indexes)
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname IN ('clinical','timeseries','labs','ops','wearables')
  AND tablename NOT LIKE 'readings\_2%'
ORDER BY 1, 2, 3
```

```sql
-- Q7: triggers and functions (both 0)
SELECT (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname IN ('clinical','timeseries','labs','ops','wearables')) AS triggers,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('clinical','timeseries','labs','ops','wearables','public')) AS functions
```

```sql
-- Q8: raw hospital records by source and type, with versions
SELECT source, resource_type, count(*) FILTER (WHERE is_current) AS current_rows,
       count(*) AS all_versions, max(version) AS max_version
FROM clinical.fhir_resources
GROUP BY 1, 2 ORDER BY 1, 2
```

```sql
-- Q8b: row counts of the medication coding table and other small tables
SELECT (SELECT count(*) FROM clinical.medication_request) AS medication_requests,
       (SELECT count(*) FROM clinical.medication_request_coding) AS medication_request_codings
```

```sql
-- Q9: the reserved date columns are empty
SELECT count(date_low) AS date_low, count(date_high) AS date_high,
       count(date_sort) AS date_sort, count(*) AS total
FROM clinical.fhir_resources
```

```sql
-- Q10: which sources are sandboxes
SELECT slug, sandbox FROM ops.ehr_connections
```

```sql
-- Q11: metric catalog as stored (provider, metric, unit)
SELECT source_provider, metric_type, unit, count(*) AS readings
FROM timeseries.readings
GROUP BY 1, 2, 3 ORDER BY 2, 1
```

```sql
-- Q12: context values per metric (sport/activity names of workouts and sessions excluded)
SELECT DISTINCT metric_type, context
FROM timeseries.readings
WHERE context IS NOT NULL AND metric_type NOT LIKE 'workout%' AND metric_type NOT LIKE 'session%'
ORDER BY 1, 2
```

```sql
-- Q13: users and device column
SELECT count(DISTINCT user_id) AS users,
       count(*) FILTER (WHERE source_device IS NOT NULL) AS rows_with_device
FROM timeseries.readings
```

```sql
-- Q14: context is missing on readings written before 2026-10-22
SELECT source_provider, metric_type, fetched_at < '2026-10-22' AS written_before_2026_10_22,
       count(*) FILTER (WHERE context IS NULL) AS no_context,
       count(*) FILTER (WHERE context IS NOT NULL) AS with_context
FROM timeseries.readings
WHERE metric_type IN ('heart_rate', 'heart_rate_variability_sdnn')
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
```

```sql
-- Q15: metrics whose every reading sits at 00:00 UTC (day-level values)
SELECT metric_type, source_provider
FROM timeseries.readings
GROUP BY 1, 2
HAVING bool_and(ts::time = '00:00')
ORDER BY 1
```

```sql
-- Q16: wearable documents by provider and type, with versions and day/start coverage
SELECT provider, data_type, count(*) FILTER (WHERE is_current) AS current_rows, count(*) AS all_versions,
       count(day) AS with_day, count(start_time) AS with_start
FROM wearables.records
GROUP BY 1, 2 ORDER BY 1, 2
```

```sql
-- Q17: resume points per provider
SELECT provider, count(*) AS data_types FROM ops.wearable_sync_state GROUP BY 1
```

```sql
-- Q18: sync jobs, triggers and outcomes; login status
SELECT job, trigger, status, count(*) AS runs
FROM ops.sync_runs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
```

```sql
-- Q18b: wearable login status
SELECT provider, status FROM ops.wearable_connections ORDER BY 1
```

```sql
-- Q19: lab document/result statuses and extraction methods (values only)
SELECT DISTINCT 'document.status' AS field, status AS value FROM labs.documents
UNION SELECT DISTINCT 'result.status', status FROM labs.results
UNION SELECT DISTINCT 'document.extraction_method', extraction_method FROM labs.documents
ORDER BY 1, 2
```

```sql
-- Q19b: confirmed results always share their document's collection date
SELECT count(*) FILTER (WHERE r.collected_date IS DISTINCT FROM d.collected_date) AS differing,
       count(*) AS confirmed
FROM labs.results r JOIN labs.documents d ON d.id = r.document_id
WHERE r.status = 'confirmed'
```

```sql
-- Q20: shape of structured observation values
SELECT count(*) AS total, count(value_quantity_value) AS numeric, count(value_text) AS text,
       count(value_code) AS coded,
       count(*) FILTER (WHERE value_quantity_value IS NULL AND value_text IS NULL AND value_code IS NULL) AS no_value,
       count(effective_datetime) AS with_time
FROM clinical.observation
```

```sql
-- Q21: code systems used, per table
SELECT 'observation' AS t, system FROM clinical.observation_code_coding
UNION SELECT 'condition', system FROM clinical.condition_coding
UNION SELECT 'encounter_type', system FROM clinical.encounter_type_coding
UNION SELECT 'diagnostic_report:' || field, system FROM clinical.diagnostic_report_coding
UNION SELECT 'procedure:' || field, system FROM clinical.procedure_coding
UNION SELECT 'immunization', system FROM clinical.immunization_vaccine_coding
UNION SELECT 'allergy', system FROM clinical.allergy_intolerance_coding
UNION SELECT 'document_type', system FROM clinical.document_reference_type_coding
ORDER BY 1, 2
```

```sql
-- Q21b: codings per observation
SELECT max(n) AS max_codings, round(avg(n), 2) AS avg_codings
FROM (SELECT observation_id, count(*) AS n FROM clinical.observation_code_coding GROUP BY 1) x
```

```sql
-- Q22: which link columns hold bare ids and which hold full Type/id references
SELECT k AS link_column,
       CASE WHEN r LIKE '%/%' THEN split_part(r, '/', 1) || '/…' ELSE 'bare id' END AS format,
       count(*)
FROM (
  SELECT 'observation.patient_id' AS k, patient_id AS r FROM clinical.observation UNION ALL
  SELECT 'observation.encounter_id', encounter_id FROM clinical.observation UNION ALL
  SELECT 'observation.performer_refs', unnest(performer_refs) FROM clinical.observation UNION ALL
  SELECT 'observation.has_member_refs', unnest(has_member_refs) FROM clinical.observation UNION ALL
  SELECT 'diagnostic_report.result_observation_ids', unnest(result_observation_ids) FROM clinical.diagnostic_report UNION ALL
  SELECT 'encounter.participant_refs', unnest(participant_refs) FROM clinical.encounter UNION ALL
  SELECT 'medication_request.medication_ref', medication_ref FROM clinical.medication_request UNION ALL
  SELECT 'medication_request.requester_ref', requester_ref FROM clinical.medication_request UNION ALL
  SELECT 'document_reference.author_refs', unnest(author_refs) FROM clinical.document_reference UNION ALL
  SELECT 'fhir_resources.patient_id', patient_id FROM clinical.fhir_resources
) x
WHERE r IS NOT NULL
GROUP BY 1, 2 ORDER BY 1
```

```sql
-- Q23: unenforced links that don't resolve; typed rows pointing at old versions
SELECT
  (SELECT count(*) FROM clinical.observation o WHERE o.encounter_id IS NOT NULL) AS obs_with_encounter,
  (SELECT count(*) FROM clinical.observation o WHERE o.encounter_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM clinical.encounter e WHERE e.source = o.source AND e.resource_id = o.encounter_id)) AS obs_encounter_unmatched,
  (SELECT count(*) FROM clinical.observation o WHERE o.patient_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM clinical.patient p WHERE p.source = o.source AND p.resource_id = o.patient_id)) AS obs_patient_unmatched,
  (SELECT count(*) FROM (SELECT unnest(result_observation_ids) FROM clinical.diagnostic_report) r) AS report_results_total,
  (SELECT count(*) FROM (SELECT source, unnest(result_observation_ids) AS rid FROM clinical.diagnostic_report) r
     WHERE NOT EXISTS (SELECT 1 FROM clinical.observation o WHERE o.source = r.source AND o.resource_id = r.rid)) AS report_results_unmatched,
  (SELECT count(*) FROM clinical.observation o JOIN clinical.fhir_resources f ON f.id = o.fhir_resource_id
     WHERE NOT f.is_current) AS obs_pointing_at_old_version
```

```sql
-- Q24: observations whose values exist only as components in raw JSON
SELECT count(*) AS obs_with_component,
       count(*) FILTER (WHERE o.value_quantity_value IS NULL) AS of_which_no_structured_value
FROM clinical.fhir_resources f
JOIN clinical.observation o ON o.fhir_resource_id = f.id
WHERE f.json ? 'component'
```

```sql
-- Q24b: attachment file types and download errors
SELECT resource_type, content_type, count(*) AS files, count(error) AS errors
FROM clinical.fhir_attachments GROUP BY 1, 2 ORDER BY 1, 2
```

```sql
-- Q25: metrics reported by more than one provider, with each provider's unit and scale check
SELECT metric_type, string_agg(DISTINCT source_provider || ':' || coalesce(unit, '∅'), ', ') AS providers_units
FROM timeseries.readings
GROUP BY 1 HAVING count(DISTINCT source_provider) > 1 ORDER BY 1
```

```sql
-- Q25b: oxygen saturation is on a 0-100 scale for every provider
SELECT source_provider, min(value) >= 50 AS all_on_0_100_scale
FROM timeseries.readings WHERE metric_type = 'oxygen_saturation' GROUP BY 1
```

```sql
-- Q26: days on which heart rate came from more than one provider
SELECT count(*) AS days_with_several_providers
FROM (SELECT ts::date FROM timeseries.readings WHERE metric_type = 'heart_rate'
      GROUP BY 1 HAVING count(DISTINCT source_provider) > 1) x
```

```sql
-- Q27: Whoop readings exist but no Whoop documents
SELECT (SELECT count(*) FROM timeseries.readings WHERE source_provider = 'whoop') AS whoop_readings,
       (SELECT count(*) FROM wearables.records WHERE provider = 'whoop') AS whoop_documents
```

```sql
-- Q28: current raw types without a typed table
SELECT DISTINCT resource_type FROM clinical.fhir_resources
WHERE is_current AND resource_type NOT IN ('Patient','Observation','Immunization','DiagnosticReport',
  'DocumentReference','Procedure','Condition','MedicationRequest','AllergyIntolerance','Encounter')
```

```sql
-- Q29: every stored JSON value is an object
SELECT 'clinical' AS store, jsonb_typeof(json) AS json_type, count(*) FROM clinical.fhir_resources GROUP BY 1, 2
UNION ALL
SELECT 'wearables', jsonb_typeof(json), count(*) FROM wearables.records GROUP BY 1, 2
```

```sql
-- Q30: observed values of free-text status/category columns (values only)
SELECT DISTINCT 'observation.status' AS field, status AS value FROM clinical.observation
UNION SELECT DISTINCT 'observation.category', unnest(category_codes) FROM clinical.observation
UNION SELECT DISTINCT 'condition.clinical_status', clinical_status FROM clinical.condition
UNION SELECT DISTINCT 'condition.verification_status', verification_status FROM clinical.condition
UNION SELECT DISTINCT 'condition.category', unnest(category_codes) FROM clinical.condition
UNION SELECT DISTINCT 'encounter.status', status FROM clinical.encounter
UNION SELECT DISTINCT 'diagnostic_report.status', status FROM clinical.diagnostic_report
UNION SELECT DISTINCT 'diagnostic_report.category', unnest(category_codes) FROM clinical.diagnostic_report
UNION SELECT DISTINCT 'document_reference.status', status FROM clinical.document_reference
UNION SELECT DISTINCT 'procedure.status', status FROM clinical.procedure
UNION SELECT DISTINCT 'immunization.status', status FROM clinical.immunization
UNION SELECT DISTINCT 'medication_request.status', status FROM clinical.medication_request
UNION SELECT DISTINCT 'medication_request.intent', intent FROM clinical.medication_request
ORDER BY 1, 2
```

```sql
-- Q31: provider JSON keeps local UTC offsets
SELECT data_type,
       count(*) FILTER (WHERE coalesce(json ->> 'bedtime_start', json ->> 'timestamp') ~ '[+-]\d\d:\d\d$') AS with_offset,
       count(*) AS total
FROM wearables.records
WHERE provider = 'oura' AND (json ? 'bedtime_start' OR json ? 'timestamp')
GROUP BY 1 ORDER BY 1
```

```sql
-- Q32: partitions are whole UTC months
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
FROM pg_class c
JOIN pg_inherits i ON i.inhrelid = c.oid
JOIN pg_class p ON p.oid = i.inhparent AND p.relname = 'readings'
ORDER BY c.relname DESC
LIMIT 2
```

```sql
-- Q33: share of readings that are dense per-sample series
SELECT round(100.0 * count(*) FILTER (WHERE metric_type IN ('met','sleep_movement','activity_class','heart_rate',
         'heart_rate_variability_sdnn','sleep_stage','ring_battery_level')) / count(*), 1) AS pct_dense_series
FROM timeseries.readings
```

```sql
-- Q34: Oura sleep period types and the most periods on one day
SELECT (SELECT string_agg(DISTINCT sleep_type, ', ') FROM wearables.oura_sleep) AS sleep_types,
       (SELECT max(n) FROM (SELECT day, count(*) AS n FROM wearables.oura_sleep GROUP BY day) x) AS max_periods_per_day
```

```sql
-- Q35: readings written by the previous wearables backend (fetched before 2026-10-12)
SELECT source_provider, count(*) FILTER (WHERE fetched_at < '2026-10-12') AS written_before_2026_10_12,
       count(*) AS total
FROM timeseries.readings GROUP BY 1 ORDER BY 1
```
