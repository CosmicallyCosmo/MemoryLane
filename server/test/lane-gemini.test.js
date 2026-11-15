// A memory's lane planned by Gemini, against a stand-in for the Gemini API: what is sent,
// and how a reply is checked before it is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "gemini";
process.env.GEMINI_API_KEY = "test-key";
// These tests are about lanes; the recogniser's background work would answer to the same stand-in.
process.env.ML_GEMINI_DECISIONS = "0";
process.env.ML_GEMINI_MODEL = "stand-in";
// A stand-in that answers 503 is tried again until the time is up: keep that short here.
process.env.ML_LANE_TIMEOUT_MS = "2000";
process.env.ML_TRANSCRIPT_TIMEOUT_MS = "2000";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-lane-gemini-"));
let server;
let base;

// Each test sets what the stand-in answers; every request it was sent is kept.
const realFetch = globalThis.fetch;
let reply = () => ({ status: 500, body: {} });
const sent = [];
globalThis.fetch = async (url, options) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, options);
  const body = JSON.parse(options.body);
  sent.push(body);
  const { status, body: answer } = reply(body);
  return new Response(status === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) : "bad request: audio/webm", { status });
};

const jpeg = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
const json = (method, url, body) =>
  realFetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function addMemory(name, photos, video = false) {
  const form = new FormData();
  form.append("name", name);
  form.append("story", `${name}, in the family's words.`);
  form.append("consentConfirmed", "true");
  form.append("referencePhotos", jpeg(), "object.jpg");
  for (let i = 0; i < photos; i++) form.append("memoryPhotos", jpeg(), `photo-${i}.jpg`);
  if (video) form.append("clip", new Blob([Buffer.alloc(64, 4)], { type: "video/mp4" }), "clip.mp4");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  const response = await realFetch(`${base}/api/keepsakes`, { method: "POST", body: form });
  assert.equal(response.status, 201);
  return response.json();
}

before(async () => {
  const app = createApp({ store: createStore(dir) });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let lake;

const textOf = (body) => body.contents[0].parts.map((p) => p.text ?? "").join("\n");
const shot = (media_id, at_seconds, extra = {}) => ({ media_id, at_seconds, focus_x: 0.5, focus_y: 0.5, motion: "push-in", ...extra });

test("Gemini hears the voice message, sees the photos, and its plan is checked", async () => {
  let memoryId;
  reply = (request) => {
    memoryId = /Memory id "([^"]+)"/.exec(textOf(request))[1];
    return {
      status: 200,
      body: {
        music: "bright",
        ambience: "waves",
        pace: "gentle",
        note: "The boat photo comes in when Sarah mentions the boat.",
        segments: [
          {
            memory_id: memoryId,
            shots: [
              shot("p2", 0, { focus_x: 7, focus_y: -1, motion: "spin" }),
              shot("p1", 12.5, { focus_x: 0.6, focus_y: 0.3 }),
              shot("p2", 30, { motion: "still" }),
              shot("p9", 40),
              shot("v3", 50, { motion: "still" }),
            ],
          },
          { memory_id: "k_made_up", shots: [shot("p1", 0)] },
        ],
      },
    };
  };
  lake = await addMemory("The lake", 2, true); // photos p1, p2, video v3
  const lane = lake.lane;
  assert.equal(memoryId, lake.id);

  const request = sent.at(-1);
  const parts = request.contents[0].parts;
  assert.equal(parts.filter((p) => p.inlineData?.mimeType === "image/jpeg").length, 2, "the photo of the object is not sent");
  assert.equal(parts.filter((p) => p.inlineData?.mimeType === "audio/webm").length, 1);
  assert.match(textOf(request), /Video id "v3"/);
  assert.match(textOf(request), /The lake, in the family's words/);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, "low");

  assert.deepEqual(
    lane.segments.map((s) => s.keepsakeId),
    [lake.id],
    "only the memory itself, not one the model made up",
  );
  const shots = lane.segments[0].shots;
  assert.deepEqual(
    shots.map((s) => s.kind),
    ["photo", "photo", "video"],
    "a photo is used once, and a made-up one not at all",
  );
  assert.deepEqual(shots[0].focus, [0.95, 0.05], "focus is kept inside the picture");
  assert.equal(shots[0].motion, "push-in", "an unknown motion becomes the gentle default");
  assert.equal(shots[1].at, 12.5);
  assert.equal(lane.music, "bright");
  assert.equal(lane.ambience, "waves");
  assert.match(lane.note, /boat/);
});

test("a change in words sends the current plan and the request, and can be undone", async () => {
  reply = (body) => {
    assert.match(textOf(body), /The family asked for this change: "Leave out the video and make it slower"/);
    assert.match(textOf(body), /"media_id":"v3"/);
    return {
      status: 200,
      body: { music: "bright", ambience: "waves", pace: "slower", note: "Left out the video and slowed it down.", segments: [{ memory_id: lake.id, shots: [shot("p2", 0)] }] },
    };
  };
  const response = await json("POST", `/api/keepsakes/${lake.id}/lane/revise`, { request: "Leave out the video and make it slower" });
  assert.equal(response.status, 200);
  const revised = await response.json();
  assert.equal(revised.pace, "slower");
  assert.equal(revised.segments[0].shots.length, 1);
  assert.equal(revised.canUndo, true);
  const undone = await (await json("POST", `/api/keepsakes/${lake.id}/lane/undo`)).json();
  assert.equal(undone.segments[0].shots.length, 3);
});

test("a recording the model refuses is left out and the plan made from photos and words", async () => {
  let calls = 0;
  reply = (body) => {
    calls++;
    const hasAudio = body.contents[0].parts.some((p) => p.inlineData?.mimeType.startsWith("audio/"));
    if (hasAudio) return { status: 400, body: {} };
    const memoryId = /Memory id "([^"]+)"/.exec(textOf(body))[1];
    return {
      status: 200,
      body: { music: "warm", ambience: "none", pace: "gentle", note: "Arranged from the photos.", segments: [{ memory_id: memoryId, shots: [shot("p1", 0, { motion: "still" })] }] },
    };
  };
  const garden = await addMemory("The garden", 1);
  assert.equal(calls, 2);
  assert.match(garden.lane.note, /photos/);
});

test("a memory with no photos or video is not sent to the model", async () => {
  const before = sent.length;
  const teapot = await addMemory("The teapot", 0);
  assert.equal(teapot.lane, null);
  assert.equal(sent.length, before);
});

test("when the model is down a new memory still gets a simple lane, but a change is refused", async () => {
  reply = () => ({ status: 503, body: {} });
  const down = await addMemory("Down", 2);
  assert.equal(down.lane.segments[0].shots.length, 2);
  assert.match(down.lane.note, /simple arrangement/);
  const revise = await json("POST", `/api/keepsakes/${down.id}/lane/revise`, { request: "Slower" });
  assert.equal(revise.status, 503);
});
