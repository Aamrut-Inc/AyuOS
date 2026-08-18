#!/usr/bin/env bash
# Run at login (via a launchd LaunchAgent) so the local wearables stack
# reconnects automatically after the laptop was off. `docker compose up -d`
# is a no-op for anything already running, so this is safe to fire every
# login even if the stack came back on its own via container restart
# policies (restart: unless-stopped) and Docker Desktop's own autostart.
#
# Waits for the Docker daemon since it may still be starting up right after
# login, especially if Docker Desktop itself was just launched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$REPO_ROOT/.ensure-stack-up.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

log "Waiting for Docker daemon..."

i=0
until docker info >/dev/null 2>&1 || [ "$i" -ge 40 ]; do
  sleep 3
  i=$((i + 1))
done

if ! docker info >/dev/null 2>&1; then
  log "Docker daemon did not come up after $((i * 3))s — giving up."
  exit 1
fi

log "Docker daemon is up after $((i * 3))s. Running docker compose up -d..."

cd "$REPO_ROOT"
if docker compose up -d >> "$LOG_FILE" 2>&1; then
  log "docker compose up -d succeeded."
else
  log "docker compose up -d failed — see above."
  exit 1
fi
