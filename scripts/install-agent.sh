#!/usr/bin/env bash
# Installs AyuOS as a macOS login agent: the app (web UI + background sync
# scheduler) starts at login, restarts if it crashes, and catches up on
# anything missed while the laptop was off or asleep.
#
# The app is copied to ~/Library/Application Support/AyuOS/app and run from
# there, because macOS blocks background processes from reading
# Desktop/Documents/Downloads, where this repo usually lives. Re-run this
# script after pulling new code so the installed copy picks it up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPPORT_DIR="$HOME/Library/Application Support/AyuOS"
APP_DIR="$SUPPORT_DIR/app"
LOG_DIR="$HOME/Library/Logs/AyuOS"
LABEL="com.ayuos.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEGACY_LABEL="com.ayuos.wearables-up"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "The login agent is macOS-only. On other systems run: bun run dev:app"
  exit 1
fi

BUN="$(command -v bun || true)"
if [[ -z "$BUN" && -x "$HOME/.bun/bin/bun" ]]; then BUN="$HOME/.bun/bin/bun"; fi
if [[ -z "$BUN" ]]; then
  echo "Bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "No .env in $REPO_ROOT — run scripts/start.command first."
  exit 1
fi

mkdir -p "$APP_DIR" "$LOG_DIR"

# The installed app may have created the wearables user and written its id to
# its own .env. Carry it back so the copy below doesn't drop it — losing it
# would make the app create a second, empty user.
installed_user_id="$(grep -E '^OPEN_WEARABLES_USER_ID=.+' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
repo_user_id="$(grep -E '^OPEN_WEARABLES_USER_ID=.+' "$REPO_ROOT/.env" | head -1 | cut -d= -f2- || true)"
if [[ -n "$installed_user_id" && -z "$repo_user_id" ]]; then
  if grep -q '^OPEN_WEARABLES_USER_ID=' "$REPO_ROOT/.env"; then
    sed -i '' "s|^OPEN_WEARABLES_USER_ID=.*|OPEN_WEARABLES_USER_ID=$installed_user_id|" "$REPO_ROOT/.env"
  else
    echo "OPEN_WEARABLES_USER_ID=$installed_user_id" >> "$REPO_ROOT/.env"
  fi
fi

echo "Copying app to $APP_DIR ..."
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'services' \
  --exclude '.DS_Store' --exclude '*.log' \
  "$REPO_ROOT/" "$APP_DIR/"

echo "Installing dependencies and running migrations ..."
(cd "$APP_DIR" && "$BUN" install --frozen-lockfile >/dev/null && "$BUN" run migrate >/dev/null)

# Retire the old Docker-only login helper; the app now brings the stack up.
if [[ -f "$LEGACY_PLIST" ]]; then
  launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" >/dev/null 2>&1 || true
  rm -f "$LEGACY_PLIST"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN</string>
        <string>run</string>
        <string>app/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$BUN"):/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>AYUOS_DATA_DIR</key>
        <string>$SUPPORT_DIR/data</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/app.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/app.log</string>
</dict>
</plist>
PLIST

# bootout returns before the old instance is fully unloaded; bootstrapping
# too early fails with "Input/output error".
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Waiting for the app on http://127.0.0.1:3000 ..."
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/api/status; then
    echo "AyuOS is running and will start automatically at login."
    echo "Logs: $LOG_DIR/app.log"
    exit 0
  fi
  sleep 3
done

echo "The app didn't respond yet. Check $LOG_DIR/app.log"
exit 1
