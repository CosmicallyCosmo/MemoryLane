#!/usr/bin/env bash
# Run the phone app on simulated glasses, from Git Bash on Windows (or Linux): the server with the demo
# household, the Android emulator, and the app installed and switched to simulated glasses.
# (On Linux use ./dev.sh.)
#
#   ./sim.sh            use the APK already built, building it only if there is none
#   ./sim.sh --build    build the APK again first
#   ./sim.sh --audio    start the emulator with sound, to hear voice messages (not verified)
#   ./sim.sh --seed     build the demo household again from the recordings, losing what was added
#   AVD=name ./sim.sh   pick the emulator image; otherwise the first one listed
#
# The demo household (server/data-recordings) is built from the recordings in recordings/ (or
# ML_RECORDINGS) the first time, and kept after that: the glasses copies made in the family app
# ("Put it on the glasses") live in it, and building it again drops them.
#
# Whatever is already running is left as it is: a server on the port, a booted emulator.
# Ctrl-C stops the server if this script started it. The emulator and the app keep running.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-8787}
BUILD=0
SEED=0
AUDIO=-no-audio
for arg in "$@"; do
  case $arg in
    --build) BUILD=1 ;;
    --audio) AUDIO= ;;
    --seed) SEED=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# Android SDK: env var, else the usual place on Windows (Git Bash) or Linux.
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [[ -z $SDK ]]; then
  for d in "$HOME/AppData/Local/Android/Sdk" "$HOME/Android/Sdk"; do
    [[ -d $d ]] && { SDK=$d; break; }
  done
fi
ADB=$SDK/platform-tools/adb
EMULATOR=$SDK/emulator/emulator
[[ -x $ADB || -x $ADB.exe ]] || { echo "No Android SDK found (${SDK:-none}). Set ANDROID_HOME." >&2; exit 1; }
# Gradle cannot run on the newest Java; Android Studio brings one that works.
if [[ -z ${JAVA_HOME:-} ]]; then
  for d in "/c/Program Files/Android/Android Studio/jbr" "$HOME"/.jdks/jdk-21* "$HOME"/.jdks/jdk-17*; do
    [[ -d $d ]] && { JAVA_HOME=$d; break; }
  done
  [[ -n ${JAVA_HOME:-} ]] || { echo "Set JAVA_HOME to a JDK 17 or 21 (Gradle cannot run on Java 25)." >&2; exit 1; }
fi
export JAVA_HOME
export ANDROID_HOME=$SDK

APP=com.memorylane.glasses/.MainActivity
APK=$ROOT/android/app/build/outputs/apk/debug/app-debug.apk
LOGS=$ROOT/server/data-recordings/dev
mkdir -p "$LOGS"
healthy() { curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; }

echo "== Server"
SERVER_PID=
if healthy; then
  echo "Already running on http://localhost:$PORT. Left as it is."
  [[ $SEED == 0 ]] || echo "Not built again: stop that server first to use --seed." >&2
else
  for dir in server family; do
    [[ -d $ROOT/$dir/node_modules ]] || (cd "$ROOT/$dir" && npm install)
  done
  (cd "$ROOT/family" && npm run build >/dev/null)
  if [[ $SEED == 1 || ! -f $ROOT/server/data-recordings/db.json ]]; then
    # Relative, so a Windows node can read it from Git Bash.
    RECORDINGS=${ML_RECORDINGS:-../recordings}
    echo "Building the demo household from $RECORDINGS"
    (cd "$ROOT/server" && node --env-file-if-exists=.env scripts/seed-recordings.mjs "$RECORDINGS")
  fi
  (cd "$ROOT/server" && PORT=$PORT exec node --env-file=recordings.env --env-file-if-exists=.env src/index.js) \
    >"$LOGS/server.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  until healthy; do
    kill -0 $SERVER_PID 2>/dev/null || { cat "$LOGS/server.log"; exit 1; }
    sleep 0.5
  done
  echo "Started on http://localhost:$PORT (log: $LOGS/server.log)"
fi

echo "== Emulator"
if ! "$ADB" devices | tr -d '\r' | grep -qw 'device$'; then
  AVD=${AVD:-$("$EMULATOR" -list-avds | tr -d '\r' | grep -v '^INFO' | head -1)}
  [[ -n $AVD ]] || { echo "No emulator image. Make one in Android Studio's Device Manager." >&2; exit 1; }
  echo "Starting $AVD (log: $LOGS/emulator.log). The first start takes a few minutes."
  # -gpu host: with the software renderer the emulator has crashed when video plays on the display.
  "$EMULATOR" -avd "$AVD" $AUDIO -no-boot-anim -gpu host >"$LOGS/emulator.log" 2>&1 &
  EMULATOR_PID=$!
  disown $EMULATOR_PID
  "$ADB" wait-for-device
  until [[ $("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; do
    kill -0 $EMULATOR_PID 2>/dev/null || { echo "The emulator stopped. Close other programs to free memory, then see $LOGS/emulator.log." >&2; exit 1; }
    sleep 2
  done
else
  echo "A device is already attached. Using it."
fi
# The app looks for the server on its own port 8787, whichever port it has here.
"$ADB" reverse tcp:8787 "tcp:$PORT" >/dev/null

echo "== Phone app"
if [[ $BUILD == 1 || ! -f $APK ]]; then
  (cd "$ROOT/android" && ./gradlew assembleDebug -q)
fi
# The family web app serves the APK, for installing on a real phone.
[[ -d $ROOT/family/dist ]] && cp "$APK" "$ROOT/family/dist/memorylane.apk"
"$ADB" install -r -g "$(cygpath -w "$APK" 2>/dev/null || echo "$APK")" >/dev/null
"$ADB" logcat -c
# MSYS would turn the leading slash of an argument into a Windows path.
start() { MSYS_NO_PATHCONV=1 "$ADB" shell am start -n $APP "$@" >/dev/null; }
start --es action simulated
sleep 4
start --es action sync

cat <<EOF

Family app:  http://localhost:$PORT
Phone APK:   http://<this computer's address>:$PORT/memorylane.apk
Phone app:   on the emulator, with simulated glasses. Tap the display preview as the touchpad.
Drive it from another Git Bash window:
  ADB="$ADB"; APP=$APP
  \$ADB shell am start -n \$APP --es action look            # look at what is in front
  \$ADB shell am start -n \$APP --es say "'Who is Maya?'"   # press talk and say this
  \$ADB shell am start -n \$APP --es open <memory id>       # open one memory
  (actions: simulated look who see home pause talk doff don battery_low sync lens lens_off)
Memory ids:
EOF
curl -s "http://127.0.0.1:$PORT/api/keepsakes" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { for (const k of JSON.parse(s)) console.log(`  ${k.id}  ${k.name}`); } catch { console.log("  (could not list them)"); }
  });' || true

echo
echo "== Logs (app: MemoryLane, server: [server]). Ctrl-C to stop."
[[ -n $SERVER_PID ]] && tail -n0 -f "$LOGS/server.log" | sed -u 's/^/[server] /' &
"$ADB" logcat -v time -s MemoryLane:I
