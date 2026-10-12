#!/usr/bin/env bash
# Builds AyuOS.app (window + menu-bar status) into ~/Applications and starts
# its menu-bar icon at login. Needs the Xcode Command Line Tools (swiftc).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HOME/Applications/AyuOS.app"
LABEL="com.ayuos.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Skipping AyuOS.app: needs Apple's Command Line Tools (xcode-select --install). AyuOS still works in the browser."
  exit 0
fi

echo "Building AyuOS.app ..."
swiftc -O -framework AppKit -framework WebKit "$HERE/AyuOSApp.swift" -o "$WORK/AyuOS"

# Icon: draw once, then every size macOS wants.
swift "$HERE/make-icon.swift" "$WORK/icon.png" 2>/dev/null
mkdir -p "$WORK/AyuOS.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/AyuOS.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/AyuOS.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AyuOS.iconset" -o "$WORK/AyuOS.icns"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/AyuOS" "$APP/Contents/MacOS/AyuOS"
cp "$WORK/AyuOS.icns" "$APP/Contents/Resources/AyuOS.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AyuOS</string>
  <key>CFBundleDisplayName</key><string>AyuOS</string>
  <key>CFBundleIdentifier</key><string>com.ayuos.app.ui</string>
  <key>CFBundleExecutable</key><string>AyuOS</string>
  <key>CFBundleIconFile</key><string>AyuOS</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

# Menu-bar status at login (window stays closed until you open it).
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$APP/Contents/MacOS/AyuOS</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true

echo "Installed $APP (also in Launchpad/Spotlight as \"AyuOS\")."
