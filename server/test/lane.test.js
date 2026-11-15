// Memory lanes with no model: a memory's photos and video become its lane, with the simple
// plan; changes by hand and undo; the glasses copy; and lanes saved by an older version.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-lane-"));
let server;
let base;

const jpeg = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
const json = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function memoryForm(name, { photos = 0, video = false, voice = true, object = true } = {}) {
  const form = new FormData();
  form.append("name", name);
  form.append("from", "Sarah");
  form.append("consentConfirmed", "true");
  if (object) form.append("referencePhotos", jpeg(), "object.jpg");
  for (let i = 0; i < photos; i++) form.append("memoryPhotos", jpeg(), `photo-${i}.jpg`);
  if (video) form.append("clip", new Blob([Buffer.alloc(64, 4)], { type: "video/mp4" }), "clip.mp4");
  if (voice) form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  return form;
}

const post = (form) => fetch(`${base}/api/keepsakes`, { method: "POST", body: form });

async function addMemory(name, options) {
  const response = await post(memoryForm(name, options));
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
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let lake;

test("a memory needs a photo of the object and a voice message", async () => {
  const noVoice = await post(memoryForm("Quiet", { photos: 1, voice: false }));
  assert.equal(noVoice.status, 400);
  assert.match((await noVoice.json()).error, /voice message/);
  const noObject = await post(memoryForm("Nothing to see", { photos: 1, object: false }));
  assert.equal(noObject.status, 400);
  assert.match((await noObject.json()).error, /object/);
});

test("a memory with only a voice message has no lane", async () => {
  const teapot = await addMemory("The teapot");
  assert.equal(teapot.lane, null);
  assert.equal((await fetch(`${base}/api/keepsakes/${teapot.id}/lane`)).status, 404);
});

test("photos and a video become the memory's lane, spread across its voice message", async () => {
  lake = await addMemory("The lake", { photos: 2, video: true });
  const lane = lake.lane;
  assert.equal(lane.id, lake.id);
  assert.equal(lane.name, "The lake");
  assert.equal(lane.segments.length, 1);
  const [segment] = lane.segments;
  assert.equal(segment.voice, lake.voiceNote);
  assert.equal(segment.from, "Sarah");
  assert.deepEqual(
    segment.shots.map((s) => s.kind),
    ["photo", "photo", "video"],
    "the photos of the object are not in it",
  );
  assert.ok(segment.shots.every((s) => s.at === null));
  assert.equal(segment.shots[2].motion, "still");
  assert.equal(lane.lens, null);
  assert.deepEqual(await (await fetch(`${base}/api/keepsakes/${lake.id}/lane`)).json(), lane);
});

test("a change in words is refused without a model; music, sound and pace change by hand and undo", async () => {
  const revise = await json("POST", `/api/keepsakes/${lake.id}/lane/revise`, { request: "Slower" });
  assert.equal(revise.status, 409);
  assert.match((await revise.json()).error, /Gemini/);

  const changed = await (await json("PATCH", `/api/keepsakes/${lake.id}/lane`, { music: "tender", pace: "slower", ambience: "loud" })).json();
  assert.equal(changed.music, "tender");
  assert.equal(changed.pace, "slower");
  assert.equal(changed.ambience, "none", "an unknown sound is ignored");
  assert.equal(changed.canUndo, true);
  const undone = await (await json("POST", `/api/keepsakes/${lake.id}/lane/undo`)).json();
  assert.equal(undone.music, "warm");
  assert.equal(undone.canUndo, false);
  assert.equal((await json("POST", `/api/keepsakes/${lake.id}/lane/undo`)).status, 409);
});

test("the glasses copy is stored, carried in the pack, and removed with the memory", async () => {
  const lens = `${base}/api/keepsakes/${lake.id}/lane/lens`;
  const bad = new FormData();
  bad.append("video", new Blob([Buffer.alloc(64)], { type: "video/webm" }), "lens.webm");
  assert.equal((await fetch(lens, { method: "POST", body: bad })).status, 400);

  const form = new FormData();
  form.append("version", "3");
  form.append("video", new Blob([Buffer.alloc(2048, 2)], { type: "video/mp4" }), "lens.mp4");
  form.append("audio", new Blob([Buffer.alloc(2048, 3)], { type: "audio/webm" }), "lens.webm");
  const stored = await fetch(lens, { method: "POST", body: form });
  assert.equal(stored.status, 201);
  const withLens = await stored.json();
  assert.equal(withLens.lens.version, 3);
  assert.match(withLens.lens.video, /\.mp4$/);
  const videoFile = path.join(dir, "media", path.basename(withLens.lens.video));
  assert.ok(fs.existsSync(videoFile));

  const pack = await (await fetch(`${base}/api/pack`)).json();
  assert.equal(pack.lanes, undefined);
  assert.deepEqual(pack.keepsakes.find((k) => k.id === lake.id).lane.lens, withLens.lens);

  assert.equal((await fetch(`${base}/api/keepsakes/${lake.id}`, { method: "DELETE" })).status, 204);
  assert.ok(!fs.existsSync(videoFile));
  assert.equal((await fetch(`${base}/api/keepsakes/${lake.id}/lane`)).status, 404);
});

test("with Cloudinary set up, the glasses copy's video is served from a public https address", async () => {
  const garden = await addMemory("The garden", { photos: 1 });
  const realFetch = globalThis.fetch;
  let uploaded = 0;
  process.env.CLOUDINARY_URL = "cloudinary://key:secret@demo";
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.cloudinary.com/")) return realFetch(url, options);
    uploaded++;
    return new Response(JSON.stringify({ public_id: "memorylane/garden" }), { status: 200 });
  };
  try {
    const form = new FormData();
    form.append("video", new Blob([Buffer.alloc(2048, 2)], { type: "video/mp4" }), "lens.mp4");
    form.append("audio", new Blob([Buffer.alloc(2048, 3)], { type: "audio/webm" }), "lens.webm");
    const stored = await fetch(`${base}/api/keepsakes/${garden.id}/lane/lens`, { method: "POST", body: form });
    assert.equal(stored.status, 201);
    const { lens } = await stored.json();
    assert.equal(uploaded, 1);
    assert.match(lens.video, /^https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/.+\/memorylane\/garden\.mp4$/);
    assert.match(lens.audio, /^\/media\//, "the sound stays here: the phone plays it");
    assert.ok(!fs.readdirSync(path.join(dir, "media")).some((f) => f.endsWith(".mp4") && fs.statSync(path.join(dir, "media", f)).size === 2048));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CLOUDINARY_URL;
  }
});

test("multi-memory films (tunnels) from an older version are dropped, and its memories with photos get one", () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-lane-old-"));
  try {
    fs.mkdirSync(path.join(old, "media"));
    for (const file of ["lens.mp4", "lens.webm", "p.jpg", "o.jpg", "v.webm"]) fs.writeFileSync(path.join(old, "media", file), "x");
    const keepsake = { id: "k_old", name: "Old", from: "", introLine: "", story: "", referencePhotos: ["o.jpg"], memoryPhotos: ["p.jpg"], voiceNote: "v.webm", clip: null, answers: [], people: [] };
    const lane = { id: "t_old", name: "Summers", keepsakeIds: ["k_old"], plan: { segments: [] }, history: [], lens: { video: "lens.mp4", audio: "lens.webm" } };
    fs.writeFileSync(path.join(old, "db.json"), JSON.stringify({ keepsakes: [keepsake], tunnels: [lane] }));

    const store = createStore(old);
    createApp({ store });
    assert.ok(!fs.existsSync(path.join(old, "media", "lens.mp4")));
    const saved = JSON.parse(fs.readFileSync(path.join(old, "db.json"), "utf8"));
    assert.equal(saved.tunnels, undefined);
    assert.deepEqual(saved.keepsakes[0].lane.plan.segments[0].shots.map((s) => s.file), ["p.jpg"]);
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test("a memory lane saved as keepsake.tunnel by an older version is kept as keepsake.lane", () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-lane-renamed-"));
  try {
    fs.mkdirSync(path.join(old, "media"));
    for (const file of ["p.jpg", "o.jpg", "v.webm"]) fs.writeFileSync(path.join(old, "media", file), "x");
    const plan = { segments: [{ keepsakeId: "k_old", shots: [{ file: "p.jpg", at: null, kind: "photo" }] }], music: "warm", ambience: "none", pace: "gentle", note: "kept" };
    const keepsake = { id: "k_old", name: "Old", from: "", introLine: "", story: "", referencePhotos: ["o.jpg"], memoryPhotos: ["p.jpg"], voiceNote: "v.webm", clip: null, answers: [], people: [], tunnel: { plan, version: 3, history: [], lens: null } };
    fs.writeFileSync(path.join(old, "db.json"), JSON.stringify({ keepsakes: [keepsake] }));

    const store = createStore(old);
    createApp({ store });
    store.save();
    const saved = JSON.parse(fs.readFileSync(path.join(old, "db.json"), "utf8")).keepsakes[0];
    assert.equal(saved.tunnel, undefined);
    assert.equal(saved.lane.version, 3);
    assert.equal(saved.lane.plan.note, "kept");
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});
