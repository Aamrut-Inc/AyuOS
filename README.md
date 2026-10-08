# AyuOS

## Getting started

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and
[Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`), then:

```
git clone https://github.com/Aamrut-Inc/AyuOS.git
cd AyuOS
./scripts/start.command
```

That brings up Postgres for AyuOS itself, plus the whole `services/wearables`
backend (its own Postgres, Redis, Celery workers, and the Svix webhook
service) locally — no external deployment required — wires the auto-seeded
local API key into `.env` automatically, and starts the AyuOS app at
`http://127.0.0.1:3000`. On macOS the app is installed as a login agent, so it
keeps running in the background (see below).

**Real credentials are not in this repo, on purpose — they're real secrets.**
Ask a teammate for:
- `OURA_CLIENT_ID`/`OURA_CLIENT_SECRET`, `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET`
  → put in `services/wearables/backend/config/.env`
- `FHIR_CLIENT_ID` (Epic sandbox — lower stakes, no paired secret, no real
  patient data; you can also just register your own free sandbox app at
  https://fhir.epic.com) → put in `.env`

The redirect URI `http://localhost:8000/api/v1/oauth/{provider}/callback`
already needs to be, and already is, allow-listed on Oura's and Whoop's side
— that's shared across everyone running locally, nothing to redo per-person.

### Manual steps (what `start.command` does, for reference)

```
cp .env.example .env
cp services/wearables/backend/config/.env.example services/wearables/backend/config/.env

docker compose up -d

# API key is auto-seeded on container startup and written to
# services/wearables/backend/.local/dev-api-key — copy that value into
# .env as OPEN_WEARABLES_API_KEY.

bun install
bun run migrate
bun run dev:app
```

## Background sync (macOS)

`start.command` runs `scripts/install-agent.sh`, which copies the app to
`~/Library/Application Support/AyuOS/app` and registers it with launchd
(`com.ayuos.app`). macOS blocks background processes from reading
Desktop/Documents/Downloads, which is why it runs from a copy.

- Starts at login and restarts within 30s if it crashes.
- On startup it launches Docker Desktop if needed and starts the containers.
- Wearables are copied into `timeseries.readings` every 15 minutes. After the
  laptop wakes (or the app starts), it asks the wearables backend to pull from
  Oura/Whoop immediately, waits for the network to be back, then catches up
  everything missed while it was closed.
- Failed runs retry with backoff (1, 2, 4 … 30 min). Every run is logged in
  `ops.sync_runs` and shown under "Background sync" on the home page, along
  with a warning when a provider's login has expired and needs a reconnect.

**After pulling new code, re-run `./scripts/install-agent.sh`** — the agent
runs the installed copy, not your checkout. Logs:
`~/Library/Logs/AyuOS/app.log`. Remove with `./scripts/uninstall-agent.sh`.
To run from the checkout instead (`bun run dev:app`), uninstall the agent
first, since both use port 3000.

## Lab report PDFs

Drop lab report PDFs on the home page (or `/labs`). Everything happens on this
laptop: the text layer is read with macOS PDFKit, and scanned pages are OCR'd
with Apple's Vision framework (`extract/lab-pdf/pdf-text.swift`, compiled on
first use — needs the Xcode Command Line Tools: `xcode-select --install`).

`transform/lab-results.ts` reads each row as test name / value / flag / units /
reference range, matches the name against common analytes
(`transform/lab-analytes.ts`, US and Indian naming, with a suggested LOINC code),
and detects the collection date. **Nothing counts until it's reviewed**: the
review page shows every candidate next to the line it was read from, pre-ticks
confident ones, and lets you fix values before saving. Originals are kept in
`~/Library/Application Support/AyuOS/data/lab-pdfs/`; results land in
`labs.documents` / `labs.results` (only `status = 'confirmed'` rows are real data).
