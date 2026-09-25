#!/usr/bin/env bash
# Emulator smoke test for the EDIT Android shell. Run by .github/workflows/android.yml
# inside reactivecircus/android-emulator-runner, where every `script:` line is its own
# shell - hence one script file so state (PID etc.) carries across steps.
set -euo pipefail
PKG=io.github.nomataiga.edit
APP_URL="https://nomataiga-del.github.io/edit-app/"

# 1) the signed release APK: installs, launches, receives the share sheet, no crash
adb install -r apk/EDIT-android.apk
adb logcat -c
adb shell am start -n "$PKG/.MainActivity"
sleep 30
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "https://example.com/products/test-jacket" -n "$PKG/.MainActivity"
sleep 12
adb logcat -d > logcat.txt
echo "--- EDIT / Capacitor lines ---"
grep -E " EDIT |Capacitor" logcat.txt | head -40 || true
if grep -q "FATAL EXCEPTION" logcat.txt; then echo "CRASH"; grep -A 25 "FATAL EXCEPTION" logcat.txt | head -60; exit 1; fi
grep -q "share -> ${APP_URL}?text=" logcat.txt && echo "SHARE OK" || { echo "share log missing"; exit 1; }
adb shell dumpsys activity activities | grep -q "$PKG/.MainActivity" && echo "ACTIVITY OK" || { echo "activity not running"; exit 1; }

# 2) rendering proof: the debug variant (same code) exposes its WebView to DevTools;
#    the page list must show the live app URL and title.
adb uninstall "$PKG" >/dev/null || true
adb install -r apk-debug/EDIT-android-debug.apk
adb logcat -c || true
adb shell am start -n "$PKG/.MainActivity" || true
SOCK=""
for i in $(seq 1 12); do
  sleep 5
  SOCK=$(adb shell cat /proc/net/unix 2>/dev/null | grep -o "webview_devtools_remote_[0-9]*" | head -1 | tr -cd "a-z_0-9" || true)
  [ -n "$SOCK" ] && break
done
echo "devtools socket=$SOCK"
if [ -z "$SOCK" ]; then
  echo "debug app did not expose a WebView DevTools socket - diagnostics:"
  adb shell "ps -A | grep -i nomataiga" || true
  adb shell dumpsys activity activities | grep -i "nomataiga" | head -5 || true
  adb logcat -d | grep -aE "FATAL|AndroidRuntime|nomataiga|Capacitor|chromium" | tail -40 || true
  exit 1
fi
adb forward tcp:9222 "localabstract:$SOCK"
PAGES=$(curl -s http://localhost:9222/json || true)
echo "$PAGES" | grep -E '"(url|title)"' | head -6 || true
if echo "$PAGES" | grep -q "nomataiga-del.github.io/edit-app" && echo "$PAGES" | grep -q "EDIT"; then
  echo "RENDER OK"
else
  echo "live app not rendered in WebView"; echo "$PAGES" | head -c 600; exit 1
fi
