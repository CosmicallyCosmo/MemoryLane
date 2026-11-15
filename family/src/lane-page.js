// The phone app's full-screen lane: opened in a WebView as /lane.html?id=<memory id>&code=…, so the
// phone shows exactly what the family app previews. One big button; it fades away while the
// film plays and comes back with a tap.
import { createLanePlayer } from "./lane/player.js";

const params = new URLSearchParams(window.location.search);
const canvas = document.getElementById("stage");
const message = document.getElementById("message");
const controls = document.getElementById("controls");
const toggle = document.getElementById("toggle");
let player = null;
let quietTimer = 0;

function say(text) {
  message.textContent = text;
  message.hidden = !text;
}

function size() {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round((canvas.clientWidth || window.innerWidth) * ratio);
  canvas.height = Math.round((canvas.clientHeight || window.innerHeight) * ratio);
  player?.redraw();
}

function showControls() {
  controls.classList.remove("quiet");
  clearTimeout(quietTimer);
  if (player?.playing) quietTimer = setTimeout(() => controls.classList.add("quiet"), 3000);
}

function update() {
  toggle.textContent = player?.playing ? "Pause" : player && player.time >= player.duration - 0.1 ? "Watch again" : "Play";
  showControls();
}

async function playOrPause() {
  if (!player) return;
  if (player.playing) player.pause();
  else await player.play();
  update();
}

async function start() {
  const id = params.get("id");
  const code = params.get("code");
  if (!id) return say("No memory was chosen.");
  try {
    // The household code, once, for a session cookie that the photos and recordings use too.
    if (code) await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const response = await fetch(`/api/keepsakes/${encodeURIComponent(id)}/lane`);
    if (!response.ok) return say(response.status === 404 ? "This memory isn't here any more." : "The memories can't be reached just now.");
    const lane = await response.json();
    canvas.setAttribute("aria-label", `Memory lane: ${lane.name}`);
    size();
    player = await createLanePlayer({ canvas, lane, onEnd: update });
  } catch {
    return say("The memories can't be reached just now.");
  }
  say("");
  controls.hidden = false;
  // The app allows sound without a tap; a browser may not, and then the button waits.
  const started = player.play().catch(() => {});
  await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 800))]);
  update();
  started.then(update);
}

window.addEventListener("resize", size);
new ResizeObserver(size).observe(canvas);
toggle.addEventListener("click", (event) => {
  event.stopPropagation();
  playOrPause();
});
document.addEventListener("click", showControls);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && player?.playing) {
    player.pause();
    update();
  }
});
start();
