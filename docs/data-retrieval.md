# Data Retrieval Layer — Full Reference

How AyuOS pulls health data in: hospital records (Epic FHIR), wearables (Oura, Whoop), Apple Health exports, and lab report PDFs. Written so a cold-start engineer or agent has the full picture without re-deriving it from the code. Paths are relative to the repo root.

---

## 1. What this layer does

A person's health data is scattered across systems with different shapes, scales and auth models:

- **Hospital records** live in EHRs (Epic) behind SMART-on-FHIR OAuth, as FHIR resources. Low frequency, high semantic complexity (coded values, units, reference ranges).
- **Wearables** live in vendor clouds (Oura, Whoop) behind their own OAuth. High frequency, mostly a number + timestamp + unit, and each vendor defines "the same" metric differently.
- **Apple Health** arrives as an `export.zip` the user uploads.
- **Lab report PDFs** are uploaded and read on-device.

Everything lands in **one local Postgres database** (embedded, no Docker) on the user's Mac. Nothing is sent to an AyuOS server.

The code keeps a strict **extract → transform → load** boundary:
- `extract/` talks to the outside world (Epic, Oura, Whoop, files); no knowledge of AyuOS's schema.
- `transform/` maps external shapes into AyuOS's tables.
- `load/` is the only code that writes to the database.
- `app/` orchestrates (web UI, scheduler, OAuth callbacks); `cli/` has command-line equivalents.

---

## 2. Runtime

- **Background app** (`app/server.ts`), installed as a launchd login agent by `scripts/install-agent.sh` (runs a copy from `~/Library/Application Support/AyuOS/app`, since macOS blocks background reads of Desktop/Documents). Serves the UI at `http://127.0.0.1:3000`, runs the scheduler, and answers wearable OAuth callbacks on `localhost:8000`.
- **Database** (`load/db-server.ts`): Postgres 17 from the `@embedded-postgres/*` npm binaries, started by the app with `pg_ctl` as a plain local process. `127.0.0.1:5435`, data in `~/Library/Application Support/AyuOS/data/postgres`, timezone UTC, random per-install password in the macOS Keychain (service "AyuOS", account "database-password"). `DATABASE_URL` overrides it with an external Postgres.
- **AyuOS.app** (`mac/`): Swift window + menu-bar status over the same local UI.
- **Scheduler** (`app/scheduler.ts`): interval jobs, catch-up after wake (a gap between 30s ticks means the process was suspended), waits for the network, retries failures with backoff (1, 2, 4 … 30 min). Every run (scheduled or manual) is logged in `ops.sync_runs`.
- **Secrets**: `shared/keychain.ts` (Keychain) and `shared/crypto.ts` (AES-256-GCM for OAuth tokens stored in the database).

---

## 3. Sources

### 3a. Hospital records (Epic FHIR)

- **Connecting:** the user picks a health system from `extract/ehr/epic-endpoints.json` (Epic's public directory, bundled; refresh with `bun scripts/update-epic-endpoints.ts`). Before sending them to MyChart, `extract/ehr/auth/check-client.ts` asks that hospital's authorize endpoint (no login) whether it knows the app's client ID. Connected hospitals are in `ops.ehr_connections`; each gets its own Sync button.
- **App registration:** Open Epic app "AyuOS Full Record". Production client ID `FHIR_CLIENT_ID`, sandbox `FHIR_SANDBOX_CLIENT_ID`. Redirect URI `FHIR_REDIRECT_URI` = `https://ishaan-netizen.github.io/ayuos-callback/`, a static forwarding page (repo `ishaan-netizen/ayuos-callback`) that bounces the browser to the app listening on `http://127.0.0.1:8765` (`callbackListenUri`). SMART v2 scopes, public client with PKCE.
- **Import** (`extract/ehr/sync.ts`): a one-time full-history pull per login (Epic's token lasts ~1 hour and the user chose not to use refresh tokens). Every default resource type (`extract/ehr/config.ts`: Patient, AllergyIntolerance, CarePlan, CareTeam, Condition, Device, DiagnosticReport, DocumentReference, Encounter, FamilyMemberHistory, Goal, Immunization, MedicationRequest, MedicationStatement, Observation, Procedure, QuestionnaireResponse, ServiceRequest, Specimen); for each, one uncategorized search plus one per category (20 Observation categories, 4 Condition, clinical-note), de-duplicated. 400/403/404/422 = "not offered here", skipped; 401/429/5xx fail the run.
- **Attachments** (`extract/ehr/fhir/attachments.ts`): DocumentReference/DiagnosticReport files are downloaded in the same session (they need the token), stored content-addressed under the data dir, recorded in `clinical.fhir_attachments`.
- **Storage:** raw resources in `clinical.fhir_resources` (append-only versions, `is_current`, content hash); `transform/run.ts` maps Patient, Observation, Immunization, DiagnosticReport, DocumentReference, Procedure, Condition, MedicationRequest, AllergyIntolerance, Encounter into typed `clinical.*` tables. Other types stay raw.

### 3b. Wearables (Oura, Whoop)

- **Connecting:** `/connect/oura|whoop` → provider login → `http://localhost:8000/api/v1/oauth/<provider>/callback` (the URI registered in both developer consoles; served by `app/wearable-callback.ts`) → code exchanged with the team's client credentials (`OURA_*`/`WHOOP_*` in `.env`). Tokens in `ops.wearable_connections`, encrypted.
- **Sync** (`extract/wearables/sync.ts`), per provider every 30 min and after wake: from `last_synced_at − 3 days` (first sync: 10 years) to now. The resume point advances only if every data type succeeded; 403/404 = not available for this account, skipped.
- **Token refresh** happens under a row lock (`load/wearable-connections.ts`), because Oura and Whoop rotate refresh tokens and revoke the whole login if one is replayed. A refused refresh marks the connection `needs_reconnect` (shown on the home page).
- **Mapping** (same metric names/units/timestamps the old wearables backend used, so history is continuous):
  - Oura (`extract/wearables/oura.ts`): `daily_activity` → steps / energy (active kcal) / distance_walking_running; `daily_readiness` → skin_temperature_deviation / skin_temperature_trend_deviation; `daily_cardiovascular_age` → cardiovascular_age; `daily_spo2` → oxygen_saturation / breathing_disturbance_index; `vO2_max`; `heartrate` (30-day request chunks) → heart_rate; `sleep` 5-minute series → heart_rate and heart_rate_variability_sdnn; `personal_info` → weight / height when changed.
  - Whoop (`extract/wearables/whoop.ts`): scored `recovery` → resting_heart_rate / heart_rate_variability_rmssd / oxygen_saturation / skin_temperature (at `created_at`); scored `cycle` → average_heart_rate / max_heart_rate (at `start`); body measurement → height / weight / max_heart_rate when changed.
- **Storage:** `timeseries.readings` (partitioned by month; key = user, metric, ts, provider). Single local user, id `AYUOS_USER_ID`.

### 3c. Apple Health

`export.zip` dropped on the home page → `extract/apple-health/parse-vitals.ts` → `timeseries.readings` (source `apple_health`).

### 3d. Lab report PDFs

Uploaded → `extract/lab-pdf/pdf-text.swift` (PDFKit text layer; Vision OCR for scanned pages) → `transform/lab-results.ts` (row parser, analyte dictionary with suggested LOINC codes, collection date) → `labs.documents` / `labs.results`. Only rows a human confirmed on the review page (`status = 'confirmed'`) are real data.

---

## 4. Database schemas

- `clinical` — FHIR raw store + typed tables + `fhir_attachments`.
- `timeseries` — `readings`.
- `labs` — `documents`, `results`.
- `ops` — `sync_runs` (run log), `ehr_connections`, `wearable_connections`.

Migrations: `load/migrations/*.sql`, idempotent, applied by `bun run migrate` and on every install. Tests (`bun test`) use a separate `ayuos_test` database.

---

## 5. Lessons learned

**Epic:**
- Observation searches are rejected without a `category`; fetching a single category silently missed labs and vitals. Condition and DocumentReference also split by category.
- Newer Epic apps match the redirect URI **exactly** (`/callback` appended → `error=4` after MyChart login). Production apps require an https redirect URI, hence the forwarding page.
- Once an app is marked **Ready** it can't be edited; APIs must be chosen up front. Prefer `.Search` APIs (a `.Read` API can only fetch one known record).
- "Automatic Client Distribution: USCDI v3" rolls the app out to hundreds of Epic customers without asking each; reach varies by organization and over time. `scripts/check-epic-client.sh` (or the in-app check) tells whether a hospital has it — verified against known-good and made-up client IDs.
- Stanford's production endpoint (`sfd.stanfordmed.org`) refuses connections from outside the US (network-level, unrelated to Epic's "Keys enabled").
- SMART `aud` (the exact FHIR base URL) is required on the authorize request.

**Wearables:**
- Oura and Whoop rotate refresh tokens; concurrent refreshes with the same token killed a Whoop connection (Aug 2026). Hence the row lock.
- Whoop's refresh request must restate `scope=offline`; Whoop validates redirect URI and scopes *before* login (so a wrong value fails immediately), while `request_forbidden` *after* login is an account-level restriction at Whoop.
- Oura caps `heartrate` requests at 30 days; sources repeat readings at chunk boundaries, so batches are de-duplicated before upsert.
- Oura and Whoop define overlapping metrics differently (e.g. HRV is SDNN on Oura, RMSSD on Whoop) — kept as distinct metric types.

**Storage:**
- Binding a JSON string to `::jsonb` stores a JSON *string*; use `::text::jsonb`. (All earlier FHIR rows were stored as strings and were repaired.)
- Date-only FHIR values are pinned to UTC midnight; the database runs in UTC.
- A full disk wedges everything; the home page warns below 5 GB free.

---

## 6. Limitations

- Hospital records are a manual, one-time pull per login (no background refresh) by design.
- Wearable OAuth secrets are shared with each install (team-only for now); a hosted token broker is the path for outside users. Oura/Whoop developer apps are capped (~10 users) until approved.
- Only Oura and Whoop are implemented directly; others (Garmin, Fitbit, …) need their own fetchers and developer registrations.
- Sleep sessions and workouts are not stored as events, only their time series.
- Apple Health is upload-only (automatic sync would need an iPhone app).
- macOS only.
