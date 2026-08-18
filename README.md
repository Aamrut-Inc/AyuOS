# AyuOS

## Getting started

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/), then:

```
git clone https://github.com/Aamrut-Inc/AyuOS.git
cd AyuOS
./scripts/start.command
```

That brings up Postgres for AyuOS itself, plus the whole `services/wearables`
backend (its own Postgres, Redis, Celery workers, and the Svix webhook
service) locally — no external deployment required — wires the auto-seeded
local API key into `.env` automatically, and starts the AyuOS app at
`http://127.0.0.1:3000`.

Click "Connect" next to Oura or Whoop on the login page to go through real
OAuth consent — this requires real Oura/Whoop OAuth client credentials in
`services/wearables/backend/config/.env` (`OURA_CLIENT_ID`/`OURA_CLIENT_SECRET`,
`WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET`), and the redirect URI
`http://localhost:8000/api/v1/oauth/{provider}/callback` must be added to the
allowed redirect list in Oura's and Whoop's developer app settings, or
consent will fail with a redirect-mismatch error.

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
