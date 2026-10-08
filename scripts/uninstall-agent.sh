#!/usr/bin/env bash
# Stops AyuOS from running in the background and at login. Your data (the
# Docker databases and ~/Library/Application Support/AyuOS/data) is kept.
set -euo pipefail

LABEL="com.ayuos.app"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/AyuOS/app"
echo "AyuOS login agent removed."
