#!/bin/bash
# Install Work on a phone that is on the tailnet but not on this network.
#
#   ./ios/ota.sh          # build, publish, print the link
#   ./ios/ota.sh --off    # stop serving and remove the tailnet path
#
# Apple's own wireless install needs mDNS on the local link, which Tailscale
# does not carry — so `devicectl` reports the phone as unavailable from another
# network. This goes the other way: iOS installs any signed build from an HTTPS
# URL it trusts, and `tailscale serve` provides exactly that on the tailnet,
# with a real certificate. The phone's UDID is already in the development
# profile from an earlier cabled install, which is what makes it installable.
set -euo pipefail

cd "$(dirname "$0")"
TEAM="${WORK_TEAM:-$(security find-certificate -c "Apple Development" -p 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null | grep -oE 'OU=[A-Z0-9]+' | cut -d= -f2)}"
PORT="${WORK_OTA_PORT:-8792}"
OUT="${TMPDIR:-/tmp}/work-ota"
# Every app installs from one namespace, one app per leaf, so publishing one
# never unmounts another and the tailnet has a single obvious place to look.
WEBPATH="${WORK_OTA_PATH:-/ios-installer/work}"
HOST="$(tailscale status --json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

if [ "${1:-}" = "--off" ]; then
  tailscale serve --set-path "$WEBPATH" off 2>/dev/null || true
  pkill -f "http.server $PORT" 2>/dev/null || true
  echo "ota: stopped serving; the tailnet path is removed"
  exit 0
fi

[ -n "$HOST" ] || { echo "ota: tailscale is not reporting a hostname" >&2; exit 1; }
[ -n "$TEAM" ] || { echo "ota: no Apple Development certificate; set WORK_TEAM" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/serve"
echo "ota: archiving…"
xcodebuild -project Work.xcodeproj -scheme Work -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Work.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates archive | tail -1

cat > "$OUT/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>debugging</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict></plist>
PLIST

echo "ota: exporting…"
xcodebuild -exportArchive -archivePath "$OUT/Work.xcarchive" \
  -exportOptionsPlist "$OUT/export.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates | tail -1
cp "$OUT/export/Work.ipa" "$OUT/serve/"

APP="$OUT/Work.xcarchive/Products/Applications/Work.app"
VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP/Info.plist")
# Read from the build rather than hard-coding: the manifest must name the same
# id the signed app carries, and a rename cannot desync it.
BUNDLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist")

cat > "$OUT/serve/manifest.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
  <key>assets</key><array><dict>
    <key>kind</key><string>software-package</string>
    <key>url</key><string>https://$HOST$WEBPATH/Work.ipa</string>
  </dict></array>
  <key>metadata</key><dict>
    <key>bundle-identifier</key><string>$BUNDLE</string>
    <key>bundle-version</key><string>$VER</string>
    <key>kind</key><string>software</string>
    <key>title</key><string>Work</string>
  </dict>
</dict></array></dict></plist>
PLIST
plutil -lint "$OUT/serve/manifest.plist" > /dev/null

cat > "$OUT/serve/index.html" <<HTML
<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Work</title>
<style>body{font:17px -apple-system,system-ui;margin:0;min-height:100vh;display:grid;
place-items:center;background:#0f0f14;color:#e8e8f0}
a{display:block;padding:18px 34px;background:#8b7cf7;color:#fff;text-decoration:none;
border-radius:14px;font-weight:700}
p{color:#8b8b9c;font-size:14px;text-align:center;max-width:22rem;line-height:1.5}</style>
<div style="display:grid;gap:22px;justify-items:center">
<svg width="76" height="76" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#8b7cf7"/>
<path d="M300 118 L196 394" stroke="#fff" stroke-width="52" stroke-linecap="round"/></svg>
<a href="itms-services://?action=download-manifest&url=https://$HOST$WEBPATH/manifest.plist">Install Work $VER ($BUILD)</a>
<p>Tap install, then find Work on the home screen. The phone has to be on the tailnet.</p>
</div>
HTML

pkill -f "http.server $PORT" 2>/dev/null || true
( cd "$OUT/serve" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 & )
sleep 2
# A PATH mapping, never the root: whatever is already served at / stays there.
tailscale serve --bg --set-path "$WEBPATH" "http://127.0.0.1:$PORT" >/dev/null

echo
echo "  Open this on the phone:  https://$HOST$WEBPATH/"
echo "  Work $VER ($BUILD) · $(du -h "$OUT/serve/Work.ipa" | cut -f1)"
echo "  Stop serving with:       ./ios/ota.sh --off"
