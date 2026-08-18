# Data Retrieval Layer — Full Reference

Everything AyuOS knows about pulling health data in from the outside world: EHR/FHIR (hospital records) and wearables (Oura, Whoop, etc.). Written to give a cold-start agent full context without needing to re-derive any of this from the codebase.

All paths below are relative to the AyuOS repo root (`/Users/gurcharansingh/Desktop/hospitaldata/AyuOS`) unless stated otherwise.

---

## 1. What problem this layer solves

A person's health data is scattered across systems that don't talk to each other, in incompatible shapes, at incompatible scales:

- **Hospital/clinical data** lives inside EHR systems (Epic, etc.) behind SMART-on-FHIR OAuth, structured as FHIR resources (JSON documents with their own internal reference graph — an `Observation` points at a `Patient` and an `Encounter` by ID, a `DiagnosticReport` points at `Observation`s it's built from, etc.). Low frequency (a handful of records per visit), high semantic complexity (coded values, units, reference ranges).
- **Wearable data** lives inside vendor clouds (Oura, Whoop, Garmin, ...) behind their own separate OAuth systems, each with a different data model for the same underlying concept (see §5, "Oura and Whoop define resting heart rate differently"). High frequency (a heart-rate reading every few minutes, continuously), low semantic complexity (mostly just a number with a timestamp and a unit).
- **Self-reported data** (Apple Health exports) arrives as a giant XML export a user manually downloads and uploads — no API, no OAuth, just a file.

None of these three sources share a schema, a scale, a refresh cadence, or an auth model. This layer's job is to pull all three into one place (Postgres, `ayuos-db`) in a shape AyuOS's own reasoning/UI layer can query uniformly, without needing to know Epic's FHIR quirks or Oura's rate limits at query time.

The repo enforces a strict **extract → transform → load** boundary (see commit `dca2335`, "Reorganize src into extract/transform/load ETL boundary"):
- `extract/` talks to the outside world only — no knowledge of AyuOS's own schema.
- `transform/` maps external shapes into AyuOS's internal structured tables.
- `load/` is the only code that writes to Postgres.

---

## 2. Types of data coming in

### Clinical (EHR/FHIR), via Epic (or Stanford Health Care)
Resource types actually fetched, per the live `.env`'s `FHIR_RESOURCE_TYPES`:
`Patient, Observation, Immunization, DiagnosticReport, DocumentReference, Encounter, Procedure`

The code's *default* list (used if `FHIR_RESOURCE_TYPES` is unset) is wider — it also includes `Condition`, `MedicationRequest`, `AllergyIntolerance` (see `extract/ehr/config.ts:47-56`).

### Wearables, via the Open Wearables backend (see §4)
Two providers currently have real OAuth credentials configured: **Oura** and **Whoop**. The backend supports 11 providers total (see `services/wearables/backend/app/services/providers/`: apple, fitbit, garmin, google, oura, polar, samsung, strava, suunto, ultrahuman, whoop), but only Oura/Whoop are live for this project.

Metric types actually observed in the live database (from `series_type_definition`, confirmed by direct query): heart_rate, resting_heart_rate, average_heart_rate, max_heart_rate, heart_rate_variability_sdnn (Oura), heart_rate_variability_rmssd (Whoop), oxygen_saturation, breathing_disturbance_index, cardiovascular_age, skin_temperature, skin_temperature_deviation, skin_temperature_trend_deviation, steps, energy, distance_walking_running, height, weight — plus ~80 more metric type codes defined in the schema (sleep stages, running dynamics, environmental exposure, etc.) that aren't necessarily populated for every user/provider.

### Self-reported, via Apple Health export
A user exports `export.zip` from the iPhone Health app and drags it onto the AyuOS login page's dropzone. Parsed by `extract/apple-health/` (uses `unzipper` + `fast-xml-parser` — see §4 for why this is the one place third-party npm packages are used).

---

## 3. Database structure, in full

There are **two separate Postgres databases**, because there are two separate applications (see §4). AyuOS never reads/writes the wearables backend's tables directly — it only talks to it over HTTP.

### 3a. `ayuos-db` (AyuOS's own database — port 5433 locally)

Three schemas: `clinical`, `timeseries`, `public` (empty/default).

#### `clinical` schema — EHR/FHIR data

**`clinical.fhir_resources`** — the raw, append-only store. Every FHIR resource ever fetched lands here first, verbatim, before any transformation:
```sql
id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
source        TEXT NOT NULL          -- "epic_sandbox" | "stanford"
patient_id    TEXT
resource_type TEXT NOT NULL          -- "Patient", "Observation", etc.
resource_id   TEXT NOT NULL          -- the FHIR resource's own id
version       INT NOT NULL DEFAULT 1
is_current    BOOLEAN NOT NULL DEFAULT true
json          JSONB NOT NULL         -- the full resource, as received
content_hash  TEXT NOT NULL          -- sha256 of the JSON, for idempotency
date_low      TIMESTAMPTZ            -- unpopulated (see §6, deferred ADR-0002)
date_high     TIMESTAMPTZ            -- unpopulated
date_sort     TIMESTAMPTZ            -- unpopulated
fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
```
- Unique index on `(source, resource_type, resource_id) WHERE is_current` — Postgres itself enforces "exactly one current row per resource," not application code.
- Versioning logic lives in `load/raw-store.ts`: on each upsert, hash the incoming JSON; if it matches the current row's hash, no-op; otherwise mark the old row `is_current=false` and insert a new version. This makes every historical version of every resource permanently queryable, not just the latest.

**Structured tables** (one per resource type, "current-state only" — full history lives in `fhir_resources` above, these tables just hold the latest version in typed columns for easy querying). Every one of these follows the same base pattern: `id BIGINT IDENTITY PK`, `fhir_resource_id` (FK → `fhir_resources.id`), `source`, `resource_id`, `content_hash`, `transformed_at`, plus `UNIQUE(source, resource_id)`.

- **`clinical.patient`**: `family_name`, `given_names TEXT[]`, `gender`, `birth_date DATE`, `address_line/city/state/postal_code/country`, `phone TEXT[]`, `email TEXT[]`, `marital_status_code/display`, `language`.
  - Child `clinical.patient_identifier`: `patient_id` FK, `system`, `value`.
- **`clinical.observation`**: `status`, `patient_id`, `encounter_id`, `performer_refs TEXT[]`, `has_member_refs TEXT[]`, `derived_from_refs TEXT[]`, `category_codes TEXT[]`, `value_text`, `value_code`, `value_code_system`, `value_quantity_value DOUBLE PRECISION`, `value_quantity_unit`, `value_quantity_code`, `effective_datetime`.
  - Child `clinical.observation_code_coding`: `observation_id` FK, `system`, `code`, `display`.
- **`clinical.immunization`**: `status`, `patient_id`, `occurrence_datetime`, `dose_quantity_value/unit`, `site_code/system/display`, `route_code/system/display`, `lot_number`, `manufacturer_display`, `performer_refs TEXT[]`.
  - Child `clinical.immunization_vaccine_coding`: `immunization_id` FK, `system`, `code`, `display`.
- **`clinical.diagnostic_report`**: `status`, `patient_id`, `encounter_id`, `category_codes TEXT[]`, `effective_datetime`, `issued`, `conclusion_text`, `result_observation_ids TEXT[]`.
  - Child `clinical.diagnostic_report_coding`: `field CHECK IN ('code','conclusion_code')`, `system`, `code`, `display`.
  - Child `clinical.diagnostic_report_presented_form`: `content_type`, `url`, `title`.
- **`clinical.document_reference`**: `status`, `patient_id`, `category_codes TEXT[]`, `date`, `author_refs TEXT[]`, `encounter_ids TEXT[]`, `context_period_start/end`.
  - Child `clinical.document_reference_type_coding`: `system`, `code`, `display`.
  - Child `clinical.document_reference_content`: `content_type`, `url`, `title`, `position`.
- **`clinical.procedure`**: `status`, `patient_id`, `category_code/system/display`, `performed_datetime`, `report_diagnostic_report_ids TEXT[]`, `performer_refs TEXT[]`.
  - Child `clinical.procedure_coding`: `field CHECK IN ('code','reason_code')`, `system`, `code`, `display`.

**Not structured** — `Condition`, `MedicationRequest`, `AllergyIntolerance`, `Encounter` land in `fhir_resources` as raw JSON only; there is no mapper for them yet (real gap, see §6).

Migration files: `load/migrations/0001_init.sql` (raw store), `load/migrations/0002_clinical_structured.sql` (structured tables).

#### `timeseries` schema — AyuOS's local mirror of wearable data

**`timeseries.readings`** — partitioned by month (`PARTITION BY RANGE (ts)`), one partition per calendar month, created on-demand by `load/timeseries.ts`'s `ensurePartition()` the first time a reading for that month is written:
```sql
user_id         TEXT NOT NULL
metric_type     TEXT NOT NULL
ts              TIMESTAMPTZ NOT NULL
value           DOUBLE PRECISION NOT NULL
unit            TEXT
source_provider TEXT NOT NULL
source_device   TEXT
fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
PRIMARY KEY (user_id, metric_type, ts, source_provider)
```
Currently has partitions from `2024_07` through `2026_08` (whatever months have data). Upserts on conflict (same user+metric+timestamp+provider → updates value/unit/device, doesn't duplicate).

**Important**: this table is a downstream *copy*. It is not automatically populated — it only fills when `extract/wearables/sync.ts`'s `syncWearables()` is explicitly called (see §4/§6 — this was a real gap found and fixed this project).

### 3b. `wearables-db` (the Open Wearables backend's own database — port 5434 locally)

23 tables total. The ones that matter for data retrieval:

**`data_point_series`** — every individual timeseries reading (heart rate, HRV, etc.):
```sql
id                         UUID PK
recorded_at                TIMESTAMPTZ NOT NULL   -- when the reading happened
value                      NUMERIC(10,3) NOT NULL
external_id                VARCHAR(100)            -- provider's own id for this reading, if any
series_type_definition_id  INT NOT NULL FK -> series_type_definition
data_source_id             UUID NOT NULL FK -> data_source (CASCADE)
zone_offset                VARCHAR(10)
created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()   -- when WE wrote it (see §5)
UNIQUE (data_source_id, series_type_definition_id, recorded_at)  -- natural idempotency key
```

**`data_source`** — one row per (user, provider, device) combination:
```sql
id                    UUID PK
user_id               UUID NOT NULL FK -> "user" (CASCADE)
device_model          VARCHAR(100)
software_version      VARCHAR(50)
source                VARCHAR(50)
provider              VARCHAR(50) NOT NULL
user_connection_id    UUID FK -> user_connection (SET NULL)
device_type           VARCHAR(32)
original_source_name  VARCHAR(100)
UNIQUE (user_id, provider, device_model, source)
```

**`user_connection`** — one row per (user, provider) OAuth connection; this is where tokens and the sync cursor live:
```sql
id                UUID PK
user_id           UUID NOT NULL FK -> "user" (CASCADE)
provider          VARCHAR(64) NOT NULL
provider_user_id  TEXT
provider_username TEXT
access_token      TEXT
refresh_token     TEXT
token_expires_at  TIMESTAMPTZ
scope             TEXT
status            VARCHAR(64) NOT NULL          -- "active", etc.
last_synced_at    TIMESTAMPTZ                   -- the cursor; see §6 for the bug fixed here
UNIQUE (user_id, provider)
```

**`series_type_definition`** — the metric-type catalog (`code`, `unit`) — ~100 rows, seeded on every boot by `scripts/init/seed_series_types.py`, idempotent.

**`developer`** / **`api_key`** — the backend's own auth: a `developer` account (seeded on first boot, `scripts/init/seed_admin.py`) owns `api_key` rows (used via `X-Open-Wearables-API-Key` header). AyuOS's own key is auto-seeded by `scripts/init/seed_dev_api_key.py` (added this project — see §5) and written to a bind-mounted file (`services/wearables/backend/.local/dev-api-key`) that `scripts/start.command` reads and wires into AyuOS's `.env` automatically.

**Other tables** (present, less central to retrieval): `event_record` / `event_record_detail` / `sleep_details` / `workout_details` (structured sleep/workout sessions, separate from the flat `data_point_series` timeseries), `health_score` (Oura-style computed scores), `personal_record` (birth date/sex/gender), `device_type_priority` / `provider_priority` (which device/provider wins when several report the same metric), `provider_settings` (per-provider `is_enabled`, `live_sync_mode`, `webhook_secret`), `archival_settings`, `user`, `application`, `invitation`, `user_invitation_code`, `refresh_token` (developer-portal auth, not wearable OAuth).

---

## 4. Repos / codebases involved

This is **two separate applications**, merged into one repo but not one codebase:

1. **AyuOS itself** — this repo. Native TypeScript/Bun. Zero third-party npm packages for the EHR/FHIR pipeline (OAuth, PKCE, SMART discovery, FHIR client, Postgres access — all built on Bun/Web-platform built-ins: `fetch`, `Bun.serve`, Web Crypto, Bun's built-in `SQL` client). The only third-party deps in `package.json` (`fast-xml-parser`, `unzipper`) are for Apple Health XML parsing, not EHR or wearables.

2. **`services/wearables`** — a fork of **[the-momentum/open-wearables](https://github.com/the-momentum/open-wearables)** (MIT licensed, "Open Wearables" — open-source infra for wearable device data). Own FastAPI/Python backend, own Postgres, own Celery task queue, own Redis, own Svix webhook server. AyuOS talks to it purely over HTTP (`OPEN_WEARABLES_API_BASE_URL` + `X-Open-Wearables-API-Key`), never touches its tables directly. Originally deployed separately on Railway (as `aamrutDataCollection`); merged into this repo and made to run fully locally via Docker as of this project's work (commit `0dde12d`, "Merge aamrutDataCollection into services/wearables").

Merge history for context: `489c9a2` (wearables ingestion + local web app + Apple Health upload), `b124efb`/`6ed74e0`/`169888d` (merged the separate `HospitalDataCollection` extract/transform/load code into this repo's `extract/ehr`, `transform`, `load`), `9def10e` (merged `epic-sandbox-test-pipeline` branch), `0dde12d` (merged the wearables service in).

---

## 5. Key findings from building this

**EHR/FHIR side:**
- Epic rejects `Observation` searches without a `category` param — `extract/ehr/fhir/client.ts:34-41` throws a specific error if `FHIR_OBSERVATION_CATEGORY` isn't set. Live `.env` uses `FHIR_OBSERVATION_CATEGORY=survey`.
- Epic's public sandbox was validated end-to-end at commit `6744e67`. **Stanford Health Care production has since been validated too**, in a separate work session whose `.env` values were never committed (correctly — `.env` is gitignored) and so aren't reflected in this repo's current checked-in state. For whoever picks this back up: production FHIR base URL is `https://sfd.stanfordmed.org/FHIR/api/FHIR/R4`, provider name is `stanford`, and the Client ID to use is Open Epic's **"Client ID" field, not "Non-Production Client ID"** (`3fdbd5b9-809b-4aa8-9c7f-992c485640d6` at time of writing). The endpoint URL was found via Epic's own official directory at `open.epic.com/MyApps/Endpoints` → Production Endpoints table → search "Stanford" → Org ID 520 (exactly one entry; a third-party mirror, `mock.health`, independently lists the same host). Real patient data (self) was successfully pulled end-to-end against this endpoint. These values aren't recoverable from git history — they need to be re-entered by hand.
- Stanford access wasn't obtained by asking Stanford directly — the app's "Automatic Client Distribution: USCDI v3" setting in Open Epic (Cures Act–driven auto-adoption) had already propagated the production client ID to 500+ Epic customer orgs, Stanford among them (confirmed via Build Apps → the app → "Review & Manage Downloads" → search the org name → status "Keys enabled"). Any other Epic-based hospital the client ID has already reached the same way is worth checking there first, before assuming a new hospital needs a bespoke registration/approval process.
- SMART "aud" parameter (bound to the exact FHIR base URL) is required by Epic on the authorize request — see `smart-oauth.ts`'s `buildAuthorizeUrl`.
- Only one OAuth attempt can hold the local callback port (8765) at a time — a second `/connect/ehr` click cancels the first in-flight attempt (`app/server.ts`, explicit comment at lines 26-29) to avoid `EADDRINUSE`.
- **On the "60-minute token window" claim**: not encoded, enforced, or documented anywhere in this codebase (checked exhaustively — `expires_in` is defined on `TokenResponse` but never read or acted on anywhere; no refresh-token flow exists at all). May be true as an operational fact about Epic's actual token lifetime, but AyuOS's code doesn't know about or handle it — a sync running longer than the real token lifetime just fails with a 401 mid-pagination, no retry.
- **On "VPN needed outside the US" — this one is confirmed, not just a claim.** Stanford's production endpoint (`sfd.stanfordmed.org`) resolves fine in public DNS and, reached via a US-based network path, returns a live, correctly-configured FHIR `CapabilityStatement` (Epic software "November 2025", real OAuth `authorize`/`token` URIs under the same host). But direct connections from at least one non-US network are refused at the TCP/TLS layer — reproduced independently via browser, `curl`, and a separate remote fetch tool, all failing without a VPN and succeeding through a US exit node. This is a network/firewall-level restriction on Stanford's edge, not an Epic/OAuth-level restriction (see next bullet) — and there is no code anywhere in this repo that knows about it, retries around it, or surfaces a distinguishing error for it. It currently just presents as a generic connection failure indistinguishable from a real outage or misconfiguration.
- **Epic's "Keys enabled" status (Build Apps → Manage Keys, per organization) is not the same thing as network reachability.** "Keys enabled" for an org (e.g. Stanford, Org ID 520) means Epic has approved/propagated the app's OAuth client registration to that organization's instance — it says nothing about whether that organization's network firewall actually lets your traffic through. Two separate systems, two separate owners (Epic vs. the health system's own IT); don't assume one implies the other when debugging a connection failure against a "production ready" org.

**Wearables side:**
- Oura and Whoop define "resting heart rate" and related metrics differently and report on different schedules — don't assume metric semantics are identical across providers just because the metric type code matches.
- Real OAuth consent requires the exact local redirect URI (`http://localhost:8000/api/v1/oauth/{provider}/callback`) to be added to the allowed redirect list in *each* provider's own developer console — Oura and Whoop each maintain their own separate allowlist; adding it on one side does nothing for the other. Learned by hitting `invalid_request` / redirect-mismatch errors on first real test.
- Whoop's `capabilities()` reports `rest_pull=True` (`services/wearables/backend/app/services/providers/whoop/strategy.py:54-56`) — the periodic Celery-beat REST poll is the real data path. Whoop also has a webhook system (`app/services/providers/whoop/webhook_handler.py`), but it's explicitly "notify-only" per its own docstring — the payload doesn't carry data, just a signal to go re-fetch via REST. Not required for data to flow.
- A cursor-advance bug was found and fixed in `services/wearables/backend/app/integrations/celery/tasks/sync_vendor_data_task.py` (~line 340): `last_synced_at` now only advances `if not is_historical and final_status == SyncStatus.SUCCESS` — previously a partially- or fully-failed sync could still move the cursor forward, permanently losing the un-synced window. Verified live: a real Whoop token-refresh failure (`invalid_client`, from placeholder local dev credentials before real ones were pulled from Railway) correctly left `last_synced_at` untouched, while a genuine Oura success correctly advanced it.
- `timeseries.readings` (AyuOS's own mirror, §3a) is **not** populated automatically just because a real OAuth connection succeeds in the wearables backend — that only updates `wearables-db`. A real gap was found here: the original `/connect/oura`/`/connect/whoop` routes only did the OAuth redirect and never triggered `syncWearables()` into AyuOS's own database. Fixed by adding `/connect/wearables/callback` (`app/server.ts`) as the actual `redirect_uri` passed to the wearables backend's `/authorize` endpoint — it's hit automatically right after consent completes, and it kicks off the background sync into `timeseries.readings`.
- `WEARABLE_SYNC_DAYS` (default 90, `extract/wearables/config.ts`) bounds how far back AyuOS's own mirror sync reaches — it is a rolling recent window, not full history. The wearables backend's own database (`wearables-db`) retains full history regardless; only the local mirror is windowed.
- The wearables backend auto-triggers a historical backfill immediately on successful OAuth connect (`HISTORICAL_SYNC_ON_CONNECT=true`, default) — no manual sync call needed server-side.

**Operational:**
- Docker Desktop can genuinely wedge (unresponsive daemon, `docker ps` hanging) after the host disk fills up completely — force-quitting (`pkill -9 -f "Docker.app|com.docker"`) and relaunching cleanly recovers it; a plain `osascript -e 'quit app "Docker"'` is not reliable when the daemon is already wedged.
- After such a crash, the built app image can come back with a subtly corrupted layer (`exec format error` on container start even though `docker compose build` reports everything cached) — a full `docker compose build --no-cache` is what actually fixes it; a cached rebuild silently reuses the bad layer.

---

## 6. Limitations

**EHR/FHIR:**
- No transform mapper exists for `Condition`, `MedicationRequest`, `AllergyIntolerance`, or `Encounter` — these are fetched and stored as raw JSON in `clinical.fhir_resources` but never get a structured table (`transform/run.ts`'s `mappers` dict only covers 6 of the ~10 default resource types). `Encounter` is in the live `.env`'s active resource list, so this is a live gap, not just theoretical.
- No refresh-token handling anywhere — `TokenResponse.refresh_token` and `.expires_in` are both defined but unused. A sync that runs longer than the access token's real lifetime will simply fail with a 401 mid-pagination; there's no retry.
- No pagination cap, rate-limit handling, or backoff in `fetchResourceType()` — a single failed page request aborts the entire import for that resource type with no partial-success handling.
- The egress allowlist (`network-guard.ts`) only permits the configured FHIR base/auth/token hosts. If a real EHR's `DocumentReference`/`DiagnosticReport` attachment URLs point at a different host (common for large binary content in production EHRs), fetching that content would be blocked unless `ALLOW_NON_FHIR_NETWORK=true`. Not hit yet because nothing currently fetches those attachment URLs — they're stored as bare URL strings, not followed.
- `date_low`/`date_high`/`date_sort` columns exist on `clinical.fhir_resources` but are never populated — flagged in the migration file itself as deferred pending "ADR-0002, deferred schema questions," which does not currently exist as a file anywhere in the repo.
- This repo's *checked-in* state (current `.env`) is sandbox-only. Stanford production was validated end-to-end in a separate session (see §5) — but those `.env` values live only in that session's local file, not in git, so re-establishing them here is a config step (re-enter the values in §5), not new development.
- Like the wearables side (single fixed `OPEN_WEARABLES_USER_ID` per instance, see below), the EHR/FHIR OAuth flow is effectively single-machine per session too, for a different reason: the redirect URI (`http://127.0.0.1:8765/callback`) is a loopback address, so whoever completes the browser login must do it on the same machine that's running the import process. Getting a second real patient's data into one specific machine's database today means either that patient physically uses (or remotes into) that machine to log in, or they run the importer on their own machine and hand over the resulting data afterward. True "patient logs in remotely, data lands on a different machine automatically" would need a public tunnel, a newly registered redirect URI (production apps are additive-only here and changes take hours to propagate), and a small code change to separate the advertised public redirect URI from the actual local bind address — none of that exists yet.

**Wearables:**
- AyuOS's own database only supports a single fixed user per running instance (`OPEN_WEARABLES_USER_ID` in `.env`) — no concept of multiple separate AyuOS users/logins sharing one instance. A "new user" means a fresh clone connecting their own Oura/Whoop account, not multiple people using one running copy.
- Local dev/testing depends on real OAuth app credentials (`OURA_CLIENT_ID/SECRET`, `WHOOP_CLIENT_ID/SECRET`) pulled from the team's existing Railway deployment — there isn't a separate "local-only" OAuth app registered; the local redirect URI had to be added to the same production app's allowlist.
- Whoop webhooks require a publicly reachable callback URL; `http://localhost:8000` cannot receive them at all (no tunnel currently configured). Not a blocker since REST polling is the real path (see §5), but worth knowing if lower-latency updates are ever wanted.
- The wearables backend (`services/wearables`) is a full multi-tenant SaaS-shaped application (Celery, Redis, Svix, developer/API-key auth, invitation codes) running for a single local user — meaningfully more infrastructure than a single-user use case strictly needs. This was a deliberate, explicit decision to keep Postgres + Docker for now rather than rearchitect (see project history) — noted here as a known, accepted tradeoff, not an oversight.
- `data_point_series_archive` and `archival_settings` tables exist (implying an archive/delete-after-N-days retention policy) but were not investigated as part of this pass — worth checking before assuming full history is retained forever.

**General:**
- Neither the EHR nor the wearables pipeline has automated tests covering the actual OAuth/network code paths beyond what's been exercised by hand this project (`load/raw-store.test.ts` exists but is narrow). Confidence in the flows described above comes from live, manual end-to-end testing, not a test suite.
