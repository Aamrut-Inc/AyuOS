#!/usr/bin/env bash
# Stops AyuOS from running in the background and at login. Your data (the
# database and files in ~/Library/Application Support/AyuOS/data) are kept.
set -euo pipefail

LABEL="com.ayuos.app"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/AyuOS/app"

launchctl bootout "gui/$(id -u)/com.ayuos.menubar" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/com.ayuos.menubar.plist"
pkill -f "AyuOS.app/Contents/MacOS/AyuOS" >/dev/null 2>&1 || true
rm -rf "$HOME/Applications/AyuOS.app"
echo "AyuOS background app and AyuOS.app removed."
