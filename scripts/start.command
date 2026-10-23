#!/bin/bash
# One-step setup and start for AyuOS. Double-click it in Finder, or run
# ./scripts/start.command. Safe to run again at any time: it only does what's
# missing, then (re)starts the app and opens it. No Docker needed: AyuOS runs
# its own database and talks to Oura/Whoop directly.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*"; read -r -p "Press Enter to close." _; exit 1; }

say "== AyuOS setup =="

# --- 1. Prerequisites --------------------------------------------------------
if [[ "$OSTYPE" != darwin* ]]; then
  fail "AyuOS currently runs on macOS only."
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

# --- 2. Config -------------------------------------------------------------
[ -f .env ] || { cp .env.example .env; echo "Created .env"; }

# Installs from before AyuOS dropped Docker: move the data across once.
if grep -q '^DATABASE_URL=.' .env; then
  say "Moving your data out of Docker (one time)..."
  if ! docker info >/dev/null 2>&1; then
    open -g -a Docker || true
    i=0; until docker info >/dev/null 2>&1 || [ "$i" -ge 60 ]; do sleep 3; i=$((i + 1)); done
  fi
  docker start ayuos-db wearables-db >/dev/null 2>&1 || true
  sleep 5
  bun install >/dev/null
  bun scripts/migrate-off-docker.ts || fail "Moving data out of Docker failed — nothing was deleted. Send the team the message above."
  docker stop ayuos-db wearables-db wearables-app wearables-celery-worker wearables-celery-beat wearables-svix-server wearables-redis >/dev/null 2>&1 || true
  docker update --restart=no ayuos-db wearables-db wearables-app wearables-celery-worker wearables-celery-beat wearables-svix-server wearables-redis >/dev/null 2>&1 || true
fi

# Oura/Whoop credentials are entered in the app itself (Set up Oura / Whoop
# on the home page) and kept in the Keychain.

# --- 3. App ------------------------------------------------------------------
say "Installing AyuOS and preparing its database..."
bun install >/dev/null
bun run migrate >/dev/null

# Runs AyuOS in the background from now on: starts at login, restarts if it
# crashes, and catches up on data missed while the laptop was closed.
"$REPO_ROOT/scripts/install-agent.sh"

# The AyuOS app: its own window, Dock icon, and menu-bar sync status.
"$REPO_ROOT/mac/build-app.sh" || true

if [ -d "$HOME/Applications/AyuOS.app" ]; then
  say "All set. Opening AyuOS (also in Launchpad and Spotlight)."
  open "$HOME/Applications/AyuOS.app"
else
  say "All set. AyuOS is opening in your browser."
  open "http://127.0.0.1:3000"
fi
