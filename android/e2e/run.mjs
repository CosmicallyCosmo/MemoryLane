#!/usr/bin/env node
// End-to-end test of the glasses app against simulated Ray-Ban Display glasses.
//
// Drives a debug build on an emulator or phone through adb, feeds the simulated camera
// fixed pictures, and checks what the app did from its log, from what is on the simulated
// lens, and from what the server recorded.
//
// Before running:
//   1. cd server && npm start            (with a model key, or it runs the rehearsal subset)
//   2. start the emulator with -gpu host, or plug in a phone
//   3. cd android && ./gradlew installDebug
// Then:  node android/e2e/run.mjs [--shots <dir>]
//
// The test adds its own two memories to the server's household, made from object photos in the
// demo recordings (recordings/, or ML_RECORDINGS), and pushes those photos to the phone as the
// pictures the camera "sees". Run it against a household of its own (server/data, as npm start
// uses), not the demo household, which already has these objects.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleVoice } from "../../server/scripts/sample-voice.mjs";

const PKG = "com.memorylane.glasses";
const ACTIVITY = `${PKG}/.MainActivity`;
const SERVER = process.env.ML_SERVER || "http://127.0.0.1:8787";
const PREVIEW_PORT = 9000;
// The app always talks to 8787 on the phone; this is the port the server listens on here.
const HOST_PORT = new URL(SERVER).port || "80";
const RECORDINGS = path.resolve(process.env.ML_RECORDINGS || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "recordings"));
// What the camera is shown: the two memories' objects, and an object that holds no memory.
const FRAMES = {
  "frame_keychain.jpg": "elephant object.small.jpg",
  "frame_lantern.jpg": "garden object 1.jpeg",
  "frame_stranger.jpg": "christmas object 1.jpeg",
};
const recording = (name) => path.join(RECORDINGS, name);
const shotsFlag = process.argv.indexOf("--shots");
const SHOTS = shotsFlag > 0 ? process.argv[shotsFlag + 1] : null;

function findAdb() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Android", "Sdk"));
  if (process.env.HOME) roots.push(path.join(process.env.HOME, "Android", "Sdk"));
  for (const root of roots.filter(Boolean)) {
    for (const name of ["adb.exe", "adb"]) {
      const candidate = path.join(root, "platform-tools", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "adb";
}
const ADB = findAdb();

const adb = (...args) =>
  execFileSync(ADB, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const adbQuiet = (...args) => {
  try {
    return adb(...args);
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends the app a debug instruction, e.g. act({ action: "look" }). */
function act(extras) {
  const args = ["shell", "am", "start", "-n", ACTIVITY];
  for (const [key, value] of Object.entries(extras)) args.push("--es", key, `'${String(value).replace(/'/g, "")}'`);
  adbQuiet(...args);
}

const appLog = () =>
  adbQuiet("logcat", "-d", "-s", "MemoryLane:I")
    .split("\n")
    .map((line) => line.replace(/^.*MemoryLane: /, "").trim())
    .filter(Boolean);
const clearLog = () => adbQuiet("logcat", "-c");

/** Waits until a log line matches. Optionally repeats an action while waiting. */
async function waitLog(pattern, { timeout = 25000, retry, every = 4000 } = {}) {
  const deadline = Date.now() + timeout;
  let nextRetry = Date.now() + every;
  for (;;) {
    const hit = appLog().find((line) => pattern.test(line));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    if (retry && Date.now() > nextRetry) {
      retry();
      nextRetry = Date.now() + every;
    }
    await sleep(500);
  }
}

/** Everything written on the simulated lens right now, as one string. */
async function lensText() {
  try {
    const state = await (await fetch(`http://127.0.0.1:${PREVIEW_PORT}/device/state`)).json();
    const deviceId = state.deviceIds?.[0];
    const reply = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/display/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    const { payload } = await reply.json();
    const tree = Buffer.from(payload ?? "", "base64").toString("utf8");
    // Drop embedded images; they are megabytes of base64.
    return tree.replace(/data:image[^"]+/g, "");
  } catch {
    return null;
  }
}

async function lensShows(text, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const content = await lensText();
    if (content === null) return null; // preview server not reachable
    if (content.includes(text)) return true;
    if (Date.now() > deadline) return false;
    await sleep(600);
  }
}

/** Taps the first on-screen element with exactly this text, if there is one. */
function tapText(text) {
  adbQuiet("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adbQuiet("exec-out", "cat", "/sdcard/ui.xml");
  const node = xml.split("<node ").find((n) => n.includes(`text="${text}"`));
  const bounds = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  if (!bounds) return false;
  const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
  adbQuiet("shell", "input", "tap", String((x1 + x2) / 2), String((y1 + y2) / 2));
  return true;
}

let shotIndex = 0;
async function shot(name) {
  if (!SHOTS) return;
  await sleep(1500); // the lens preview draws a moment after its content changes
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${String(++shotIndex).padStart(2, "0")}-${name}.png`);
  fs.writeFileSync(file, execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 }));
}

// The SDK publishes speech on a StateFlow, which drops a result identical to the one before
// it. Real speech has partial results in between; injected speech does not. So a repeated
// test utterance alternates its punctuation to count as new each time.
let sayCount = 0;
function say(text) {
  const bare = text.replace(/[?.!]+$/, "");
  act({ say: sayCount++ % 2 === 0 ? `${bare}?` : bare });
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok === true ? "PASS" : ok === null ? "SKIP" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok === false) for (const line of appLog().slice(-8)) console.log(`      | ${line}`);
}

async function goHome() {
  clearLog();
  act({ action: "home" });
  await waitLog(/^Phase IDLE/, { timeout: 8000 });
}

/** Meta's own small sample clip, sized for the glasses display. Null if it cannot be fetched. */
async function sampleClip() {
  try {
    const reply = await fetch(
      "https://github.com/facebook/meta-wearables-dat-android/raw/refs/heads/assets/video_266x150_faststart.mp4",
      { signal: AbortSignal.timeout(20000) },
    );
    if (!reply.ok) return null;
    return new Blob([await reply.arrayBuffer()], { type: "video/mp4" });
  } catch {
    return null;
  }
}

// ---- Preflight -------------------------------------------------------------------------

const health = await fetch(`${SERVER}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`No server at ${SERVER}. Run "npm start" in server/ first.`);
  process.exit(2);
}
const missingFrames = Object.values(FRAMES).filter((name) => !fs.existsSync(recording(name)));
if (missingFrames.length) {
  console.error(`These demo recordings are not in ${RECORDINGS}:\n  ${missingFrames.join("\n  ")}\nSet ML_RECORDINGS to their folder.`);
  process.exit(2);
}
const sees = health.recogniser !== "rehearsal";
const jpeg = (name) => new Blob([fs.readFileSync(recording(name))], { type: "image/jpeg" });

// Looks are refused until the wearer has agreed.
const profile = await fetch(`${SERVER}/api/profile`).then((r) => r.json());
if (!profile.consent?.wearerAgreed) {
  await fetch(`${SERVER}/api/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wearerName: profile.wearerName || "Jimmy", consent: { wearerAgreed: true, agreedBy: "the end-to-end test", careSignals: true } }),
  });
}

// A relative with a profile, shown in the keychain's memory, so "who is that?" has an answer.
let members = await fetch(`${SERVER}/api/members`).then((r) => r.json());
if (!members.some((m) => m.name === "Sarah")) {
  await fetch(`${SERVER}/api/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sarah", relationship: "Daughter" }),
  });
  members = await fetch(`${SERVER}/api/members`).then((r) => r.json());
}
const sarah = members.find((m) => m.name === "Sarah");
let keepsakes = await fetch(`${SERVER}/api/keepsakes`).then((r) => r.json());

// The memory the tests look at: a written story, a voice message and answers to questions.
if (!keepsakes.some((k) => k.name === "Elephant keychain")) {
  const memory = new FormData();
  memory.append("name", "Elephant keychain");
  memory.append("description", "A small carved wooden elephant on a keyring.");
  memory.append("from", "Sarah");
  memory.append("story", "Sarah brought this back from Sri Lanka for you.");
  memory.append("consentConfirmed", "true");
  memory.append("addedBy", sarah.id);
  memory.append("referencePhotos", jpeg(FRAMES["frame_keychain.jpg"]), "keychain.jpg");
  memory.append("voiceNote", sampleVoice(12), "voice.wav");
  const created = await fetch(`${SERVER}/api/keepsakes`, { method: "POST", body: memory });
  if (!created.ok) {
    console.error("Could not add the test memory:", await created.text());
    process.exit(2);
  }
  const { id } = await created.json();
  for (const [question, text] of [
    ["Who gave me this?", "I did, Dad. I brought it back from Sri Lanka."],
    ["Where is this from?", "From a market in Kandy, in Sri Lanka."],
  ]) {
    const answer = new FormData();
    answer.append("question", question);
    answer.append("text", text);
    answer.append("speaker", "Sarah");
    await fetch(`${SERVER}/api/keepsakes/${id}/answers`, { method: "POST", body: answer });
  }
  keepsakes = await fetch(`${SERVER}/api/keepsakes`).then((r) => r.json());
}
const keychain = keepsakes.find((k) => k.name === "Elephant keychain");
{
  const intro = new FormData();
  intro.append("introText", "It's Sarah, your daughter.");
  await fetch(`${SERVER}/api/members/${sarah.id}/profile`, { method: "POST", body: intro });
  await fetch(`${SERVER}/api/keepsakes/${keychain.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ people: [sarah.id] }),
  });
  // A second memory that carries real media: a recorded voice message and a video.
  if (!keepsakes.some((k) => k.name === "Garden lantern")) {
    const memory = new FormData();
    memory.append("name", "Garden lantern");
    memory.append("description", "A metal garden lantern hung up for a party.");
    memory.append("from", "Sarah");
    memory.append("story", "We hung this in the garden for the summer party.");
    memory.append("consentConfirmed", "true");
    memory.append("addedBy", sarah.id);
    memory.append("referencePhotos", jpeg(FRAMES["frame_lantern.jpg"]), "lantern.jpg");
    memory.append("voiceNote", sampleVoice(), "message.wav");
    // Video is opt-in (--video): playing it has crashed the emulator on some machines. The video
    // makes the memory a lane, and saying yes to it plays the lane's glasses copy. That copy
    // is normally recorded in the family app's browser; here Meta's sample clip stands in for it.
    const clip = process.argv.includes("--video") ? await sampleClip() : null;
    if (clip) memory.append("clip", clip, "clip.mp4");
    const created = await fetch(`${SERVER}/api/keepsakes`, { method: "POST", body: memory });
    if (!created.ok) console.error("Could not create the media memory:", await created.text());
    else if (clip) {
      const { id } = await created.json();
      const lens = new FormData();
      lens.append("video", clip, "lens.mp4");
      lens.append("audio", sampleVoice(), "lens.wav");
      const stored = await fetch(`${SERVER}/api/keepsakes/${id}/lane/lens`, { method: "POST", body: lens });
      if (!stored.ok) console.error("Could not store the lane's glasses copy:", await stored.text());
    }
  }
  // Start from a clean slate for the everyday question this run records an answer to.
  const bank = await fetch(`${SERVER}/api/questions`).then((r) => r.json());
  for (const a of bank.answered.filter((x) => /margaret/i.test(x.question))) {
    await fetch(`${SERVER}/api/questions/${a.id}`, { method: "DELETE" });
  }
}
console.log(`Server ok, recogniser: ${health.recogniser}. adb: ${ADB}\n`);
await fetch(`${SERVER}/api/events`, { method: "DELETE" });

if (!adbQuiet("shell", "pm", "path", PKG).includes("package:")) {
  console.error('The app is not installed. Run "./gradlew installDebug" in android/ first.');
  process.exit(2);
}
// The pictures the camera "sees", where the debug build looks for them.
const frameDir = `/sdcard/Android/data/${PKG}/files/test-camera`;
adbQuiet("shell", "mkdir", "-p", frameDir);
for (const [frame, name] of Object.entries(FRAMES)) adb("push", recording(name), `${frameDir}/${frame}`);
adbQuiet("reverse", "tcp:8787", `tcp:${HOST_PORT}`);
adbQuiet("forward", `tcp:${PREVIEW_PORT}`, `tcp:${PREVIEW_PORT}`);
for (const permission of ["CAMERA", "RECORD_AUDIO", "BLUETOOTH_CONNECT", "POST_NOTIFICATIONS"]) {
  adbQuiet("shell", "pm", "grant", PKG, `android.permission.${permission}`);
}
adbQuiet("shell", "am", "force-stop", PKG);
clearLog();
adbQuiet("shell", "am", "start", "-n", ACTIVITY);
// Taps and intents sent in the first seconds after a cold start are lost.
await sleep(9000);

// ---- 1. Connect --------------------------------------------------------------------------

// Listening is off until the family turns it on; the spoken tests below need it.
act({ action: "listen_on" });
act({ action: "simulated" });
const started = await waitLog(/^Session STARTED/, { timeout: 60000 });
const idle = started && (await waitLog(/^Phase IDLE/, { timeout: 15000 }));
record("simulated glasses connect and reach the home screen", Boolean(idle));
if (!idle) {
  console.error("\nCould not connect simulated glasses; stopping.\n" + appLog().slice(-15).join("\n"));
  process.exit(1);
}
// An emulator offers to download a speech model the first time speech starts. Decline it.
await sleep(1500);
tapText("Cancel");
if (SHOTS) act({ action: "lens" });
act({ action: "preview" });
await sleep(2500);
const greeting = await lensShows("What's this?", 6000);
record("the lens shows the home screen", greeting, greeting === null ? "lens preview server not reachable" : "");
await shot("home");

// ---- 2. A keepsake is recognised -----------------------------------------------------------

if (sees) {
  clearLog();
  act({ test_frame: "frame_keychain.jpg" });
  await waitLog(/^Test frame set/, { timeout: 8000 });
  act({ action: "look" });
  const looked = await waitLog(/^Looked in \d+ ms: k_/, { timeout: 30000 });
  const memory = looked && (await waitLog(new RegExp(`^Phase MEMORY ${keychain.id}`), { timeout: 10000 }));
  record("asking about an object that holds a memory opens it straight away", Boolean(memory), looked ?? "no look result");
  const named = await lensShows(keychain.name);
  record("the lens shows the keepsake's name and story", named);
  await shot("memory");
  const played = await waitLog(/^Memory played/, { timeout: 60000 });
  record("the memory is spoken to the end", Boolean(played));
} else {
  clearLog();
  act({ open: keychain.id });
  const memory = await waitLog(new RegExp(`^Phase MEMORY ${keychain.id}`), { timeout: 10000 });
  record("a memory opens from the list (rehearsal mode: no recognition)", Boolean(memory));
  await waitLog(/^Memory played/, { timeout: 60000 });
}

// ---- 3. Questions ----------------------------------------------------------------------------

// The app ignores anything heard in the moment after it stops talking (it is its own echo).
await sleep(1500);
clearLog();
const ask = () => say("Who gave me this");
ask();
// Speech heard while the app itself is talking is ignored by design, so keep asking.
const answered = await waitLog(/^Asked “Who gave me this\??”: (written|recorded)/, { timeout: 30000, retry: ask });
record("a spoken question gets the family's answer", Boolean(answered), answered ?? "");
await shot("answer");

await sleep(1500);
clearLog();
const askOdd = () => say("How much is it worth");
askOdd();
const declined = await waitLog(/^Asked “How much is it worth\??”: none/, { timeout: 40000, retry: askOdd });
record("a question nobody recorded an answer for is declined, not invented", Boolean(declined));

// ---- 3b. An everyday question: asked, sent to the family, answered from then on ------------

await goHome();
await sleep(1200);
clearLog();
const askEveryday = () => say("Where is Margaret");
askEveryday();
const unanswered = await waitLog(/^Asked “Where is Margaret\??”: none/, { timeout: 40000, retry: askEveryday });
const inbox = await fetch(`${SERVER}/api/questions`).then((r) => r.json());
record(
  "an everyday question with no answer reaches the family",
  Boolean(unanswered) && inbox.open.some((q) => /margaret/i.test(q.question)),
);
{
  const answer = new FormData();
  answer.append("question", "Where is Margaret?");
  answer.append("text", "Mum is at her sister's this week. She will be home on Friday.");
  answer.append("speaker", "Sarah");
  answer.append("addedBy", sarah.id);
  await fetch(`${SERVER}/api/questions`, { method: "POST", body: answer });
}
await waitLog(/^Answer given/, { timeout: 30000 });
await goHome();
await sleep(1200);
clearLog();
askEveryday();
const nowAnswered = await waitLog(/^Asked “Where is Margaret\??”: (written|recorded)/, { timeout: 40000, retry: askEveryday });
record("once a relative records an answer, the glasses give it", Boolean(nowAnswered));
await shot("everyday-answer");
await waitLog(/^Answer given/, { timeout: 30000 });

// ---- 3b2. A recorded voice message, or a memory lane --------------------------------------

if (sees) {
  const all = await fetch(`${SERVER}/api/keepsakes`).then((r) => r.json());
  const lantern = all.find((k) => k.name === "Garden lantern");
  if (lantern) {
    await goHome();
    act({ action: "sync" });
    await sleep(6000); // the phone downloads the recording so it can play offline
    clearLog();
    act({ test_frame: "frame_lantern.jpg" });
    await waitLog(/^Test frame set/, { timeout: 8000 });
    act({ action: "look" });
    const offered = await waitLog(/^Looked in \d+ ms: k_/, { timeout: 30000 });
    if (lantern.lane?.lens) {
      const film = offered && (await waitLog(/^Memory lane played: Garden lantern/, { timeout: 90000 }));
      await shot("lane");
      record("a memory with a lane plays it on the lens, with its sound", Boolean(film), offered ? "" : "the object was not recognised");
    } else {
      const voiced = offered && (await waitLog(/^Memory played: Garden lantern \(recording\)/, { timeout: 60000 }));
      record("a relative's recorded voice message plays", Boolean(voiced), offered ? "" : "the object was not recognised");
      record("a memory with a lane plays it on the lens, with its sound", null, "run with --video on a fresh server to include it");
    }
  }
}

// ---- 3c. Who is that? ------------------------------------------------------------------------

if (sees) {
  await goHome();
  clearLog();
  act({ test_frame: "frame_keychain.jpg" });
  await waitLog(/^Test frame set/, { timeout: 8000 });
  act({ action: "who" });
  const introduced = await waitLog(/^Said who Sarah is/, { timeout: 40000 });
  record("“who is that?” at a memory with a relative in it says who they are", Boolean(introduced));
}

// ---- 4. A distractor is rejected ------------------------------------------------------------

if (sees) {
  await goHome();
  clearLog();
  act({ test_frame: "frame_stranger.jpg" });
  await waitLog(/^Test frame set/, { timeout: 8000 });
  act({ action: "look" });
  const rejected = await waitLog(/^Looked in \d+ ms: no match/, { timeout: 30000 });
  const unknown = rejected && (await waitLog(/^Phase UNKNOWN/, { timeout: 8000 }));
  record("an everyday object is not mistaken for a keepsake", Boolean(unknown), rejected ?? "no look result");
  await shot("unknown");

  // ---- 5. Voice trigger ---------------------------------------------------------------------
  await waitLog(/^Said it holds no memory yet/, { timeout: 30000 });
  clearLog();
  act({ test_frame: "frame_keychain.jpg" });
  await waitLog(/^Test frame set/, { timeout: 8000 });
  const whatsThis = () => say("What's this");
  whatsThis();
  const byVoice = await waitLog(/^Phase MEMORY/, { timeout: 40000, retry: whatsThis, every: 6000 });
  record('saying "What\'s this?" starts a look', Boolean(byVoice));
}

// ---- 6. Glasses taken off and put back on -------------------------------------------------------

await goHome();
clearLog();
act({ action: "doff" });
const removed = await waitLog(/^Phase REMOVED/, { timeout: 10000 });
act({ action: "don" });
const back = removed && (await waitLog(/^Phase IDLE/, { timeout: 10000 }));
record("taking the glasses off pauses, putting them on resumes", Boolean(back));

// ---- 7. Privacy pause ------------------------------------------------------------------------

clearLog();
act({ action: "pause" });
const paused = await waitLog(/^Phase PAUSED/, { timeout: 10000 });
const lensPaused = await lensShows("Not looking or listening");
await shot("paused");
clearLog();
act({ action: "look" });
await sleep(4000);
const lookedWhilePaused = appLog().some((line) => /^Phase LOOKING|^Looked in/.test(line));
record("privacy pause stops looking", Boolean(paused) && !lookedWhilePaused, lensPaused === false ? "lens text missing" : "");
clearLog();
act({ action: "pause" });
const resumed = await waitLog(/^Resumed/, { timeout: 10000 });
record("resuming after a privacy pause returns to the home screen", Boolean(resumed && (await waitLog(/^Phase IDLE/, { timeout: 8000 }))));

// ---- 8. No connection -------------------------------------------------------------------------

await sleep(3000); // let the camera come back after the pause
clearLog();
adbQuiet("reverse", "--remove", "tcp:8787");
// Removing the mapping does not cut a connection that is already open, and the app keeps one
// alive for a few seconds after each request. Wait for the server to drop it (5 s idle).
await sleep(7000);
act({ action: "look" });
const offline = await waitLog(/^Could not look/, { timeout: 30000 });
const browsing = offline && (await waitLog(/^Phase BROWSE/, { timeout: 8000 }));
record("with no connection the wearer is offered the memories kept on the phone", Boolean(browsing));
await shot("offline");
clearLog();
act({ open: keychain.id });
const offlineMemory = await waitLog(new RegExp(`^Phase MEMORY ${keychain.id}`), { timeout: 10000 });
record("a memory still opens with no connection", Boolean(offlineMemory));
adbQuiet("reverse", "tcp:8787", `tcp:${HOST_PORT}`);
act({ action: "sync" });
await sleep(4000);

// ---- 9. Automatic looking -----------------------------------------------------------------------

if (sees) {
  await goHome();
  clearLog();
  act({ test_frame: "frame_keychain.jpg" });
  await waitLog(/^Test frame set/, { timeout: 8000 });
  act({ action: "auto_on" });
  const auto = await waitLog(/^Phase OFFER/, { timeout: 45000 });
  act({ action: "auto_off" });
  record("automatic looking offers the memory without being asked", Boolean(auto));
}

// ---- Heart rate while a memory is open (simulated readings) ----------------------------------
{
  const consent = (heartRate) =>
    fetch(`${SERVER}/api/profile`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: { heartRate } }) });
  const sessions = () => fetch(`${SERVER}/api/keepsakes/${keychain.id}/heart`).then((r) => r.json()).then((heart) => heart.sessions);
  const openFor = async (ms) => {
    clearLog();
    act({ action: "home" });
    act({ open: keychain.id });
    await waitLog(new RegExp(`^Phase (MEMORY|FILM) ${keychain.id}`), { timeout: 15000 });
    await sleep(ms);
    act({ action: "home" });
  };

  // Off: opening a memory sends nothing.
  await consent(false);
  act({ action: "sync" });
  await sleep(4000);
  await openFor(12000);
  act({ action: "sync" });
  await sleep(3000);
  record("with heart rate switched off, opening a memory notes nothing", (await sessions()).length === 0);

  // On: a resting rate is taken first, then the memory's session reaches the family app.
  await consent(true);
  clearLog();
  act({ action: "sync" });
  // The pulse is read from the motion Mock Device Kit replays; that takes ten seconds to settle.
  // If the replay gives nothing, the app says so and falls back to made-up readings.
  const reading = await waitLog(/^(Reading a pulse from the glasses' motion|The simulated glasses gave no motion)/, { timeout: 50000 });
  record("a pulse is read from the simulated glasses' motion", /^Reading a pulse/.test(reading ?? ""), reading ?? "no heart rate at all");
  await sleep(9000);
  await openFor(30000);
  const noted = await waitLog(/^Heart rate noted for that memory/, { timeout: 8000 });
  act({ action: "sync" });
  await sleep(3000);
  const [session] = await sessions();
  record(
    "with it on, the heart rate while the memory was open reaches the family app, marked as simulated",
    Boolean(noted) && session?.source === "simulated" && session.samples.length >= 5,
    session ? session.text : "no session stored",
  );
  await consent(false);
}

// ---- 10. Low battery ------------------------------------------------------------------------------

clearLog();
act({ action: "battery_low" });
record("a low battery is noticed", Boolean(await waitLog(/^Glasses battery is at 10%/, { timeout: 10000 })));

// ---- 11. What the server recorded ------------------------------------------------------------------

await sleep(1500);
const summary = await fetch(`${SERVER}/api/summary`).then((r) => r.json());
record(
  "the carer's summary recorded the questions, including the unanswered one",
  summary.questionsAsked >= 2 && summary.unansweredQuestions.some((q) => /worth/i.test(q.question)),
  `${summary.looks} looks, ${summary.questionsAsked} questions, median look ${summary.medianRecogniseMs ?? "?"} ms`,
);

act({ action: "lens_off" });
act({ action: "disconnect" });
const failed = results.filter((r) => r.ok === false).length;
const skipped = results.filter((r) => r.ok === null).length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`);
if (failed) console.log("\nLast app log lines:\n" + appLog().slice(-20).join("\n"));
process.exit(failed ? 1 : 0);
