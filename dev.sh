#!/usr/bin/env bash
# Run Memory Lane locally for debugging: server, family app, and the glasses app on the
# Android emulator (or a phone over USB), with both logs in this terminal.
#
#   ./dev.sh             server on 8787
#   PORT=8788 ./dev.sh   when 8787 is taken; the app still sees 8787 on the phone
#
# Server debugger: Node inspector on 127.0.0.1:9229 (chrome://inspect, or VS Code "Attach").
# Ctrl-C stops the server. The emulator and the app keep running.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8787}
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}
ADB=$SDK/platform-tools/adb
LOGS=$ROOT/server/data/dev
mkdir -p "$LOGS"

# Gradle 8.14 cannot run on Java 25. Use JAVA_HOME if set, otherwise a JDK 17 or 21 in ~/.jdks.
if [[ -z ${JAVA_HOME:-} ]]; then
  JAVA_HOME=$(ls -d "$HOME"/.jdks/jdk-21* "$HOME"/.jdks/jdk-17* 2>/dev/null | head -1 || true)
  [[ -n $JAVA_HOME ]] || { echo "Set JAVA_HOME to a JDK 17 or 21 (Gradle cannot run on Java 25)." >&2; exit 1; }
  export JAVA_HOME
fi
export ANDROID_HOME=$SDK

if ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  echo "Port $PORT is already in use ($(ss -ltnp "sport = :$PORT" | grep -o 'users:(("[^"]*' | cut -d'"' -f2))." >&2
  echo "Run with another port, for example: PORT=8788 ./dev.sh" >&2
  exit 1
fi

echo "== Dependencies and family app"
for dir in server family; do
  [[ -d $ROOT/$dir/node_modules ]] || (cd "$ROOT/$dir" && npm install)
done
(cd "$ROOT/family" && npm run build >/dev/null)

echo "== Server on http://localhost:$PORT (logs: $LOGS/server.log)"
(cd "$ROOT/server" && PORT=$PORT exec node --inspect=127.0.0.1:9229 --env-file-if-exists=.env src/index.js) \
  >"$LOGS/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
until curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; do
  kill -0 $SERVER_PID 2>/dev/null || { cat "$LOGS/server.log"; exit 1; }
  sleep 0.5
done
curl -s "http://127.0.0.1:$PORT/api/health"; echo

echo "== Device"
if ! "$ADB" devices | grep -qw device$; then
  AVD=$("$SDK/emulator/emulator" -list-avds | head -1)
  [[ -n $AVD ]] || { echo "No device attached and no emulator image." >&2; exit 1; }
  echo "Starting emulator $AVD"
  nohup "$SDK/emulator/emulator" -avd "$AVD" >"$LOGS/emulator.log" 2>&1 &
  "$ADB" wait-for-device
  until [[ $("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; do sleep 1; done
fi
"$ADB" reverse tcp:8787 "tcp:$PORT" >/dev/null

echo "== Glasses app"
(cd "$ROOT/android" && ./gradlew installDebug -q)
"$ADB" logcat -c
"$ADB" shell am start -n com.memorylane.glasses/.MainActivity >/dev/null

cat <<EOF

Family app:  http://localhost:$PORT
Phone app:   tap "Use simulated glasses" for simulated glasses.
Drive it:    $ADB shell am start -n com.memorylane.glasses/.MainActivity --es action look
             (actions: simulated look who see home pause talk doff don battery_low sync lens lens_off;
              --es say "'Where is Margaret?'" presses talk and injects speech; --es open <memory id> opens one)

== Logs (app: MemoryLane, server: [server])
EOF
tail -n0 -f "$LOGS/server.log" | sed -u 's/^/[server] /' &
"$ADB" logcat -v time -s MemoryLane:I
