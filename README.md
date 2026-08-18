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
local API key into `.env` automatically, starts the AyuOS app at
`http://127.0.0.1:3000`, and (on macOS) sets things up so Docker and the
stack come back on their own after a reboot.

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
