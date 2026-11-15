# Testing on emulated Meta Ray-Ban Display glasses

How to run and test a Device Access Toolkit (DAT) app with no glasses: an Android emulator, plus Meta's **Mock Device Kit** (MDK) acting as a Ray-Ban Display with camera, display, touchpad and speech.

Written 2026-11-14 against DAT `1.0.1` (Maven Central, `com.meta.wearable:mwdat-*`). Official docs, repos and hardware troubleshooting are in [meta-resources.md](meta-resources.md).

## Status

| Capability | Status | Evidence |
|---|---|---|
| Mock Ray-Ban Display pairs in the emulator, no glasses, no Meta AI app | **Verified** | Meta's DisplayAccess sample |
| Display UI renders in the 600×600 preview | **Verified** | Meta's DisplayAccess sample |
| Taps on the preview reach the app | **Verified** | Meta's DisplayAccess sample |
| MP4 video plays on the mock display and reports `ENDED` | **Verified** | Meta's DisplayAccess sample; logcat `VIDEO_PLAYBACK_EVENT_TYPE_ENDED` |
| Read the lens content as JSON over HTTP | **Verified** | `POST /display/content` |
| Click a lens element over HTTP | **Verified** | `POST /display/click` |
| Fake camera image, then capture | **Does not work with the phone-camera feed.** `MockCameraKit.setCapturedImage(Uri)` was ignored while the feed was `setCameraFeed(CameraFacing.BACK)`: `capturePhoto()` still returned the live emulated-camera frame. The HTTP routes were not tried. | Memory Lane works round it: in debug builds a bundled test picture replaces the captured frame inside the app (see below) |
| Fake speech | **Verified** through `MockSpeechKit.simulateTranscription`; HTTP route not tried | Memory Lane end-to-end test: injected questions are answered. Note an identical utterance sent twice in a row is dropped (the SDK publishes on a `StateFlow`) |
| Camera, display and speech in the same mock session | **Verified** (Memory Lane app, Windows emulator) | `capturePhoto()` returns a frame while the display is attached and speech is running |
| Memory Lane's whole loop on simulated glasses | **Verified**: 21 of 21 checks in `node android/e2e/run.mjs`, live Gemini, on the last full run before audio and video checks were added | Lens screenshots in [`emulator/memorylane/`](emulator/memorylane/) |
| A recorded voice message and MP4 playback in the Memory Lane app | **Not confirmed** | the end-to-end test has checks for both, but no full passing run of them is recorded. Only Meta's DisplayAccess sample has been seen playing video |
| Sound from a speaker | **Not verified** | the emulator runs with `-no-audio`; the test only sees that playback finished |
| Emulator stability with video | **Crashed twice on Windows** (exit 139 during a run that plays video; exit 21 when the in-device `screenrecord` started) | run video checks last, and record with `adb emu screenrecord`, not `adb shell screenrecord` |

## Machine setup (Linux)

Nothing here needs root. Everything is under `~/Android`.

- **Android SDK** at `~/Android/Sdk`: `platform-tools`, `emulator`, `platforms;android-36.1` (Gradle also pulled `android-36` and `build-tools;35.0.0`), `build-tools;36.1.0`, `system-images;android-36.1;google_apis;x86_64`.
- **JDK 21** at `~/Android/jdk21`. The system Java is 25, which the samples' Gradle (8.14) can't run on. Set `JAVA_HOME=~/Android/jdk21` for every Gradle command.
- **AVD** named `mlane` (Pixel 7 profile). The machine has `/dev/kvm`, so it runs at full speed.

To reproduce elsewhere: download the command-line tools (`commandlinetools-linux-*_latest.zip`), unzip them to `$ANDROID_HOME/cmdline-tools/latest`, run `yes | sdkmanager --licenses`, install the packages above, then `avdmanager create avd -n mlane -k "system-images;android-36.1;google_apis;x86_64" -d pixel_7`.

## Start the emulator

```bash
# Visible window, using the host GPU. Use this one.
~/Android/Sdk/emulator/emulator -avd mlane -no-audio -no-boot-anim -gpu host

# Optional: the laptop webcam as the phone's back camera (for the MDK "phone camera" feed)
#   add: -camera-back webcam0 -camera-front emulated
```

**Do not use `-no-window -gpu swiftshader_indirect`.** The emulator segfaulted (exit 139) twice when video started playing on the mock display. With `-gpu host` it plays fine.

Start the emulator as a tracked background job. When it was started with `nohup … &`, the process was killed when the agent session restarted.

Wait for boot:

```bash
adb wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
```

## Build and run Meta's samples

```bash
git clone --depth 1 https://github.com/facebook/meta-wearables-dat-android.git
cd meta-wearables-dat-android/samples/DisplayAccess   # or BirdSpotter, CameraAccess
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
JAVA_HOME=~/Android/jdk21 ./gradlew assembleDebug
adb install -r -g app/build/outputs/apk/debug/app-debug.apk
```

No Meta developer account or token is needed. The `mwdat_application_id` and `mwdat_client_token` keys default to `"0"`, the Developer Mode placeholder.

The repo also ships agent skills in `plugins/mwdat-android/skills/`: `mockdevice-testing`, `display-access`, `camera-capture` and others. Read them before writing DAT code.

### DisplayAccess (display and video)

Package: `com.meta.wearable.dat.externalsampleapps.displayaccess`

To get to the mock: Samples tab → **Developer preview** → **In app** (or **Chrome**) → **Preview in app** (or **Start preview server**). If it says "No eligible device available", tap **Try again**. The first attempt after launch can fail.

## Driving the mock over HTTP (the agent's test interface)

The MDK has a built-in HTTP test server. The app starts it with `mockDeviceKit.startTestServer(port)`, the same server the Chrome preview uses. Forward the port, then use `curl`:

```bash
adb forward tcp:9000 tcp:9000
curl -s 127.0.0.1:9000/health         # {"status":"ok"}
curl -s 127.0.0.1:9000/device/state   # {"pairedDeviceCount":1,"deviceIds":["<id>"]}
curl -s 127.0.0.1:9000/capabilities   # full route list
```

All POST routes take a JSON body and need the `deviceId` from `/device/state`.

**Verified:**

```bash
ID=<deviceId>
# What's on the lens right now: {"revision":N,"payload":"<base64 JSON UI tree>"}
curl -s -X POST -H 'Content-Type: application/json' -d "{\"deviceId\":\"$ID\"}" 127.0.0.1:9000/display/content
# Press a lens element by its "identifier" from the content tree
curl -s -X POST -H 'Content-Type: application/json' -d "{\"deviceId\":\"$ID\",\"identifier\":\"c0_…\"}" 127.0.0.1:9000/display/click
```

The decoded payload is the DAT UI tree: `flexBox`, `card`, `text` (`content`), `image` (`uri`), `video`, `button`, with an `identifier` on interactive elements. Tests can assert on lens text directly, without screenshots. Strip `data:image…` URIs before printing; they're large.

**Not yet tried.** The body shapes below come from the library's own error messages (`MockDeviceTestRouter` in `mwdat-mockdevice-1.0.1.aar`):

| Route | Body |
|---|---|
| `/device/pair` | `{"deviceType": …}` |
| `/device/power-on`, `/device/don`, `/device/unfold`, … | `{"deviceId"}` |
| `/captouch/tap`, `/captouch/tap-and-hold` | `{"deviceId"}` (assumed) |
| `/input/select`, `/input/back`, `/input/capture`, `/input/nav-up\|down\|left\|right`, `/input/action` | `{"deviceId"}` (assumed) |
| `/input/drag` | `{"deviceId","action","x":0,"y":0,"dx":0,"dy":0}` |
| `/camera/set-captured-image`, `/camera/set-feed`, `/capture/set-photo` | `{"deviceId","resourceName","ext"}`, see note |
| `/camera/set-facing` | `{"deviceId","facing":"front"\|"back"}` |
| `/capture/simulate-failure` | `{"deviceId"}` |
| `/speech/transcribe` | unknown |
| `/speech/error` | `{"deviceId","errorCode":0,"message"}` |
| `/speech/complete` | `{"deviceId"}` (assumed) |
| `/speech/set-locale` | `{"deviceId","locale"}` |
| `/display/video` | unknown |
| `/permissions/set`, `/permissions/set-request-result` | unknown |

**Fake camera images must be bundled in the app.** The camera routes call `copyAssetToCacheUri(resourceName, ext)`, so the image has to be in the app's `assets/`. Memory Lane avoids this: its debug build swaps the captured picture for one the test pushes to the phone (see below). In code, `MockCameraKit.setCapturedImage(Uri)` and `setCameraFeed(Uri)` take any URI, and `MockCameraCaptureKit.setCapturedPhoto(Uri)` does the same for captured photos.

## Suggested test loop for Memory Lane

1. Build the debug app with MDK enabled, the test server on a fixed port, and the test images in its assets.
2. Start the emulator (`-gpu host`), install the app and launch it with `adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`. Run `adb forward` for the port.
3. For each test image (an object that holds a memory, or a distractor): set the captured image, then send `/captouch/tap` (the user's trigger).
4. Poll `/display/content` until its `revision` changes. Assert that the intro text appears and that a `video` node (an object that holds a memory) or the "this is a fork" text (distractor) shows.
5. Check logcat for `DAT:Display` `VIDEO_PLAYBACK_EVENT_TYPE_ENDED` and record the latency.
6. Save `adb exec-out screencap -p` at each step for a person to review.

## Gotchas

- `uiautomator dump` sees the phone UI but not what's inside the lens. Use `/display/content` for that.
- The phone UI's tap coordinates move between runs (status bar height, sheet animation). Tap by label, as the replay script does.
- After a cold boot, wait about 10 s after launching the app before tapping, or the taps are lost.
- Only one app can hold a given test-server port. Force-stop the other sample first.
- The mock shows no real Bluetooth latency or brightness, and doesn't show the see-through look of the real display.

## Memory Lane on the emulator (Windows notes)

- Same recipe as above with the Windows command-line tools; the AVD is `memorylane` (`system-images;android-36;google_apis;x86_64`). `JAVA_HOME` is Android Studio's bundled JBR.
- `-gpu swiftshader_indirect` was unusable here too: the app and System UI hit "isn't responding" as soon as the mock display's WebView appeared. `-gpu host -cores 6 -memory 4096` works.
- **The emulator has crashed twice here.** Once with exit 139 during a test run that plays a video on the mock display, and once with exit 21 when `adb shell screenrecord` started. Run video checks last, so a crash costs nothing else. To record the screen use the emulator's own recorder: `adb emu screenrecord start --time-limit 70 C:\path\out.webm`, then `adb emu screenrecord stop`.
- In Git Bash, device paths such as `/sdcard/x` are rewritten into Windows paths. Set `MSYS_NO_PATHCONV=1` for adb commands that take a device path.
- The app talks to the server on the laptop through `adb reverse tcp:8787 tcp:8787`. Over that mapping the server sees the phone as loopback, so no access code is needed.
- The first time speech starts, the emulator offers to download an offline speech model. Cancel it; simulated speech does not need it.
- The home screen is the lens with **Talk**, **Look** and **Pause** under it. Tap **Use simulated glasses** to connect simulated glasses. Everything for testing is under **Settings** (the gear): the automatic-look switch, the memories on the phone, and a **Simulation** section (**Take off** / **Put on**, **Low battery**, "Something the wearer says" with a send button, and the Chrome display preview on port 9000). Debug builds also take `--es action settings` / `settings_off`.
- The full-screen button on the lens fills the screen with the simulated lens on black (Back returns). Use it for screenshots and recordings.
- While simulated glasses are connected, Back sends the app to the background. It does not end the session, and the session also survives the screen being closed.

### Start it

```bash
# Emulator (PowerShell: & "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" ...)
emulator -avd memorylane -gpu host -cores 6 -memory 4096 -no-boot-anim -no-audio
#   add  -camera-back webcam0  to hold a real object up to the laptop webcam

cd server && npm start            # terminal 2

adb reverse tcp:8787 tcp:8787
cd android && ./gradlew installDebug      # JAVA_HOME = Android Studio's bundled JBR
```

### The end-to-end test

```bash
node android/e2e/run.mjs                                     # about six to eight minutes
node android/e2e/run.mjs --shots docs/emulator/memorylane    # also saves lens screenshots
```

It needs the server running (on its own household, not the demo one), the debug app installed and the demo recordings in `recordings/` (or `ML_RECORDINGS`). Before it starts it adds what it needs through the API: a relative called Sarah with a hello, a memory ("Elephant keychain", from the recordings' photo of it) with written answers that Sarah is in, and a second memory ("Garden lantern") that carries a recorded voice message and, if it can be downloaded, Meta's small sample video. It pushes the object photos to the phone for the camera to "see". It grants the app's permissions, connects simulated glasses, and checks three things: the app's log (`adb logcat -s MemoryLane:I`), what is written on the lens (the MDK test server's `/display/content` on port 9000), and what the server recorded. In rehearsal mode it skips the checks that need recognition.

What it covers, in order:

1. Simulated glasses connect and reach the home screen; the lens shows it.
2. An object that holds a memory is **offered, not played**; choosing "See memory" opens it; the lens shows its name and words; the memory is spoken to the end.
3. A spoken question gets the family's answer; a question nobody answered is declined, not invented.
4. An everyday question ("Where is Margaret?") with no answer reaches the family; the test then records an answer through the API, asks again, and the glasses give it.
5. A recorded voice message plays. With `--video` on a fresh server, the memory gets a video and a stand-in glasses copy of its lane, and saying yes plays the lane on the lens instead (skipped if the sample video cannot be downloaded).
6. "Who is that?" at a memory with a relative in it says who they are.
7. An object that holds no memory is rejected; saying "What's this?" starts a look.
8. Glasses off and on; the pause stops looking; resuming returns to the home screen.
9. With no connection the wearer is offered the memories kept on the phone, and one still opens.
10. Automatic looking offers the memory without being asked; a low battery is noticed.
11. The family's summary recorded the questions, including the unanswered one.

What it does not show:

- **The camera.** Test pictures are swapped in for the captured frame inside the app. The glasses camera is still asked for a photo each time; its picture is replaced before sending. Debug builds only.
- **Speech recognition.** Utterances are injected as text.
- **Sound.** The emulator has none. The test only sees that playback finished, and whether the app played a recording or read the words aloud.
- A physical phone, or real glasses.

### Driving the app by hand

Debug builds accept instructions as intent extras. The activity is single-top, so each command goes to the running app:

```bash
A="adb shell am start -n com.memorylane.glasses/.MainActivity"

$A --es action simulated      # connect simulated glasses
$A --es action look           # look now ("What's this?")
$A --es action who            # look, as if "who is that?" had been asked
$A --es action see            # accept the memory on offer ("See memory")
$A --es action home           # back to the home screen
$A --es action pause          # pause on; send again to carry on
$A --es action auto_on        # automatic looking on
$A --es action auto_off
$A --es action doff           # take the glasses off
$A --es action don            # put them back on
$A --es action battery_low    # battery to 10%
$A --es action sync           # fetch memories, people and answers from the server now
$A --es action preview        # start or stop the lens preview server (port 9000)
$A --es action lens           # show only the lens, full screen
$A --es action lens_off
$A --es action disconnect

$A --es test_frame frame_keychain.jpg   # the next looks "see" this pushed picture
$A --es say "'Who gave me this?'"       # something the wearer says
$A --es open <memory id>                # play a memory straight away, with no offer
```

The test pictures are not in git. `android/e2e/run.mjs` pushes three object photos from the demo recordings to `/sdcard/Android/data/com.memorylane.glasses/files/test-camera/`: `frame_keychain.jpg` and `frame_lantern.jpg` (the two memories it adds) and `frame_stranger.jpg` (an object that holds no memory). Push your own there with `adb push` to try others.

Useful log lines (`adb logcat -s MemoryLane:I`): `Phase IDLE`, `Phase OFFER <id>`, `Phase MEMORY <id>`, `Phase PERSON`, `Phase ANSWERING`, `Looked in <ms> ms: <id or no match>`, `Offered: <name>`, `Memory played: <name> (recording)` or `(read aloud)`, `Memory lane played: <name>` (or `played by ear`), `Said who <name> is`, `Asked “<question>”: recorded | written | none`, `Answer given`.

Things that catch you out:

- **Wait about 10 seconds after a cold start** before the first command, or it is lost.
- **A match is offered, not played.** After `look`, send `see` (or `say yes`) to open the memory. The offer goes away after 25 seconds.
- **Saying the same thing twice in a row does nothing** the second time. Change the punctuation (`Who gave me this` then `Who gave me this?`) or say something else in between.
- **The microphone is push to talk.** It opens only when the capture button on the glasses is pressed (`--es action talk`, or **Talk** on the phone), for one thing said, and closes after 8 seconds with nothing heard. `--es say` presses it for you. Logged as `Talk: listening`, then `Talk: heard nothing` or `Talk: closed by a second press`.
- **Pressing talk while the app is talking stops it**, so the microphone hears the wearer. Anything transcribed within about a second of our own voice is still ignored: the microphone hears the speakers.
- **Any three-word question is treated as an everyday question** when no memory is open, and is logged for the family if they opted in.
- **Testing offline: wait about 7 seconds after `adb reverse --remove tcp:8787`** before looking. Removing the mapping does not cut a connection that is already open, and the app keeps one alive until the server drops it after 5 seconds idle. A look sent sooner still gets through.
- Re-add the mapping with `adb reverse tcp:8787 tcp:8787`, then `--es action sync`.
