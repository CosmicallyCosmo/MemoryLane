// A scripted tour for demos. Open the app with `?attract` and press T: it walks itself through
// Home, Memories, a memory, Family and a profile, gliding down each page slowly, and loops. Any click,
// key press, scroll or touch stops it, and T starts it again. It never starts by itself, so
// browsing the app normally is unaffected.
import { state } from "./state.js";

const LOAD_MS = 2500; // after a page change, for the page and its pictures to arrive
const READ_MS = 3000; // resting at the top and at the bottom of a page
const SPEED = 70; // px a second while gliding down: slow enough to read as it goes

// `go` changes page; `open` follows the first link on the page that matches, as a person would tap it.
const STEPS = [
  { go: "#/home" },
  { go: "#/memories" },
  { open: 'a[href^="#/memories/"]' },
  { go: "#/family" },
  { open: 'a[href^="#/family/"]' },
];

let runId = 0;
let touring = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bottom = () => document.documentElement.scrollHeight - window.innerHeight;

/** Scroll to `to` at a steady SPEED, one frame at a time (the browser's own smooth scroll is too quick). */
function glide(to, id) {
  return new Promise((resolve) => {
    const from = window.scrollY;
    const ms = (Math.max(to - from, 0) / SPEED) * 1000;
    const start = performance.now();
    const frame = (now) => {
      const k = ms ? Math.min(1, (now - start) / ms) : 1;
      window.scrollTo({ top: from + (to - from) * k, behavior: "instant" });
      if (k < 1 && id === runId) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

async function show(step, id) {
  if (step.go) window.location.hash = step.go;
  else document.querySelector(`#main ${step.open}`)?.click();
  await sleep(LOAD_MS);
  if (id !== runId) return;
  window.scrollTo({ top: 0, behavior: "instant" });
  await sleep(READ_MS);
  await glide(bottom(), id); // pictures that arrived late may have made the page longer
  if (id === runId) await sleep(READ_MS);
}

async function tour() {
  const id = ++runId;
  touring = true;
  while (id === runId) {
    for (const step of STEPS) {
      if (id !== runId) return;
      await show(step, id);
    }
  }
}

function stop() {
  runId++; // ends the loop at its next check
  touring = false;
}

const typing = (event) => event.target.closest?.("input, textarea, select, [contenteditable]");

export function startAttract() {
  if (new URLSearchParams(window.location.search).get("attract") === null) return;
  window.addEventListener(
    "keydown",
    (event) => {
      if (typing(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === "t" && !touring) {
        if (state.me) tour();
      } else if (touring) stop();
    },
    true,
  );
  for (const type of ["pointerdown", "wheel", "touchstart"]) {
    window.addEventListener(type, () => touring && stop(), { passive: true, capture: true });
  }
}
