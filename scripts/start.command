#!/bin/bash
# One-step setup and start for AyuOS. Double-click it in Finder, or run
# ./scripts/start.command. Safe to run again at any time: it only does what's
# missing, then (re)starts the app and opens it.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
WEARABLES_ENV="services/wearables/backend/config/.env"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*"; read -r -p "Press Enter to close." _; exit 1; }

say "== AyuOS setup =="

# --- 1. Prerequisites --------------------------------------------------------
if [[ "$OSTYPE" != darwin* ]]; then
  fail "AyuOS currently runs on macOS only."
fi

if ! command -v docker >/dev/null 2>&1 && [ ! -d /Applications/Docker.app ]; then
  open "https://www.docker.com/products/docker-desktop/"
  fail "Docker Desktop is needed. The download page just opened — install it, open it once, then run this again."
fi

export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun (the JavaScript runtime AyuOS uses)..."
  curl -fsSL https://bun.sh/install | bash || fail "Bun install failed. Install it from https://bun.sh and run this again."
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! xcode-select -p >/dev/null 2>&1; then
  say "Lab PDF reading needs Apple's Command Line Tools."
  echo "A system dialog will ask to install them — click Install. Setup continues meanwhile;"
  echo "lab PDF upload starts working once that install finishes."
  xcode-select --install >/dev/null 2>&1 || true
fi

# --- 2. Config files ---------------------------------------------------------
[ -f .env ] || { cp .env.example .env; echo "Created .env"; }
[ -f "$WEARABLES_ENV" ] || { cp "${WEARABLES_ENV}.example" "$WEARABLES_ENV"; echo "Created $WEARABLES_ENV"; }

# Ask once for each wearable's credentials (from the team) instead of having
# people edit the file. Enter skips; that wearable just can't be connected yet.
credentials_changed=0
ask_credentials() {
  local name="$1" prefix="$2" current
  current="$(grep -E "^${prefix}_CLIENT_ID=" "$WEARABLES_ENV" | cut -d= -f2-)"
  case "$current" in
    ""|public-client-id|your-*-client-id) ;;
    *) return 0 ;;
  esac
  say "$name credentials (ask the AyuOS team; press Enter to skip $name for now)"
  local id secret
  read -r -p "  $name client ID: " id
  [ -n "$id" ] || { echo "  Skipped $name."; return 0; }
  read -r -s -p "  $name client secret (hidden as you type): " secret; echo
  [ -n "$secret" ] || { echo "  No secret entered — skipped $name."; return 0; }
  bun scripts/set-env.ts "$WEARABLES_ENV" "${prefix}_CLIENT_ID" "$id"
  bun scripts/set-env.ts "$WEARABLES_ENV" "${prefix}_CLIENT_SECRET" "$secret"
  credentials_changed=1
  echo "  Saved."
}
ask_credentials "Oura" OURA
ask_credentials "Whoop" WHOOP

# --- 3. Docker stack ---------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  say "Starting Docker Desktop..."
  open -g -a Docker
fi
i=0
until docker info >/dev/null 2>&1 || [ "$i" -ge 60 ]; do sleep 3; i=$((i + 1)); done
docker info >/dev/null 2>&1 || fail "Docker didn't start. Open Docker Desktop yourself, then run this again."

say "Starting the local databases and wearables service (first run builds it — a few minutes)..."
if [ "$credentials_changed" = 1 ]; then
  docker compose up -d --force-recreate wearables-app wearables-celery-worker wearables-celery-beat
fi
docker compose up -d

i=0
until curl -sf -o /dev/null http://localhost:8000/docs || [ "$i" -ge 60 ]; do sleep 3; i=$((i + 1)); done
curl -sf -o /dev/null http://localhost:8000/docs || fail "The wearables service didn't start. Check: docker compose logs wearables-app"

KEY_FILE="services/wearables/backend/.local/dev-api-key"
i=0
until [ -s "$KEY_FILE" ] || [ "$i" -ge 20 ]; do sleep 2; i=$((i + 1)); done
[ -s "$KEY_FILE" ] || fail "The wearables service didn't create its API key. Check: docker compose logs wearables-app"
bun scripts/set-env.ts .env OPEN_WEARABLES_API_KEY "$(cat "$KEY_FILE")"

# --- 4. App ------------------------------------------------------------------
say "Installing AyuOS and preparing its database..."
bun install >/dev/null
bun run migrate >/dev/null

if ! osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q "Docker"; then
  osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Docker.app", hidden:true}' >/dev/null 2>&1 \
    && echo "Docker will start automatically when you log in."
fi

# Runs AyuOS in the background from now on: starts at login, restarts if it
# crashes, and catches up on data missed while the laptop was closed.
"$REPO_ROOT/scripts/install-agent.sh"

say "All set. AyuOS is opening in your browser."
open "http://127.0.0.1:3000"
