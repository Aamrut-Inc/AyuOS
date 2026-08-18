#!/bin/bash
# Double-click entry point: brings up the full local stack (Postgres x2, Redis,
# Celery, Svix, the wearables backend) via Docker, wires the auto-seeded API
# key into the root .env automatically, then starts the AyuOS app itself.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "== AyuOS local start =="

if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

if [ ! -f services/wearables/backend/config/.env ]; then
  echo "Creating services/wearables/backend/config/.env from .env.example..."
  cp services/wearables/backend/config/.env.example services/wearables/backend/config/.env
  echo "NOTE: that file has placeholder Oura/Whoop OAuth credentials — real consent won't work until real ones are added."
fi

echo "Waiting for Docker..."
i=0
until docker info >/dev/null 2>&1 || [ "$i" -ge 40 ]; do
  sleep 3
  i=$((i + 1))
done
if ! docker info >/dev/null 2>&1; then
  echo "Docker did not come up after $((i * 3))s. Open Docker Desktop and re-run this script."
  exit 1
fi

echo "Starting containers (docker compose up -d)..."
docker compose up -d

echo "Waiting for the wearables backend to respond on :8000..."
i=0
until curl -sf -o /dev/null http://localhost:8000/docs || [ "$i" -ge 40 ]; do
  sleep 3
  i=$((i + 1))
done
if ! curl -sf -o /dev/null http://localhost:8000/docs; then
  echo "wearables-app did not come up after $((i * 3))s. Check: docker compose logs wearables-app"
  exit 1
fi

KEY_FILE="services/wearables/backend/.local/dev-api-key"
echo "Waiting for the local API key to be seeded..."
i=0
until [ -s "$KEY_FILE" ] || [ "$i" -ge 20 ]; do
  sleep 2
  i=$((i + 1))
done
if [ ! -s "$KEY_FILE" ]; then
  echo "API key was not seeded after $((i * 2))s. Check: docker compose logs wearables-app"
  exit 1
fi

API_KEY="$(cat "$KEY_FILE")"
if grep -q "^OPEN_WEARABLES_API_KEY=" .env; then
  sed -i '' "s|^OPEN_WEARABLES_API_KEY=.*|OPEN_WEARABLES_API_KEY=$API_KEY|" .env
else
  echo "OPEN_WEARABLES_API_KEY=$API_KEY" >> .env
fi
echo "Wired local API key into .env."

if [[ "$OSTYPE" == darwin* ]]; then
  echo "Setting up auto-start on login (best-effort, macOS only)..."

  if ! osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q "Docker"; then
    if osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Docker.app", hidden:false}' >/dev/null 2>&1; then
      echo "Added Docker to login items."
    else
      echo "Could not add Docker to login items (non-fatal) — add it yourself in System Settings > General > Login Items if you want it."
    fi
  fi

  LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/com.ayuos.wearables-up.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$LAUNCH_AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ayuos.wearables-up</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_ROOT/scripts/ensure-stack-up.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REPO_ROOT/.ensure-stack-up.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_ROOT/.ensure-stack-up.launchd.log</string>
</dict>
</plist>
PLIST

  launchctl unload "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1
  launchctl load "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1
  sleep 2
  if grep -q "Operation not permitted" "$REPO_ROOT/.ensure-stack-up.launchd.log" 2>/dev/null; then
    echo "NOTE: the login helper can't run because this repo is under a macOS-protected folder"
    echo "(Desktop/Documents/Downloads). Docker's containers will still self-heal once Docker Desktop"
    echo "is open — you'll just need to open Docker Desktop yourself after a reboot. To fix for real:"
    echo "grant Full Disk Access to /bin/bash in System Settings > Privacy & Security, or clone this"
    echo "repo somewhere other than Desktop/Documents/Downloads."
  else
    echo "Installed login helper — the stack should come back up on its own after a reboot."
  fi
fi

echo "Installing dependencies and running migrations..."
bun install
bun run migrate

echo "Starting AyuOS app at http://127.0.0.1:3000 ..."
( sleep 2 && open "http://127.0.0.1:3000" ) &
bun run dev:app
