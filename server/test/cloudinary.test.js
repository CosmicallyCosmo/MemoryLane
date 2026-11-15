// Glasses copies made by Cloudinary: the addresses a plan turns into, and the server making a
// tunnel's and a hello's copy by itself. Cloudinary's API and delivery are stood in for here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
process.env.CLOUDINARY_URL = "cloudinary://key:secret@demo";
process.env.ML_CLOUDINARY_WAIT_MS = "5";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");
const { cropAround, filmSeconds, filmUrl, helloClipUrl, posterUrl } = await import("../src/cloudinary.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-cloudinary-"));
const realFetch = globalThis.fetch;
let server;
let base;
let films;

// What the stand-in saw: every API call, and every address asked for.
const api = [];
const asked = [];
let notReadyYet = 0;
let uploads = 0;

globalThis.fetch = async (url, options) => {
  const address = String(url);
  if (address.startsWith("https://api.cloudinary.com/")) {
    const [, type, action] = /\/demo\/(image|video)\/(upload|destroy)$/.exec(address);
    const body = Object.fromEntries([...options.body.entries()].filter(([, value]) => typeof value === "string"));
    api.push({ type, action, ...body });
    if (action === "destroy") return Response.json({ result: "ok" });
    if (body.public_id) return Response.json({ public_id: body.public_id });
    const id = `memorylane/a${++uploads}`;
    return Response.json(type === "image" ? { public_id: id, width: 4000, height: 3000 } : { public_id: id, width: 1920, height: 1080, duration: 30 });
  }
  if (address.startsWith("https://res.cloudinary.com/")) {
    asked.push(address);
    // Cropping around faces is worked out the first time it is asked for.
    if (address.includes("g_auto:faces") && notReadyYet-- > 0) return new Response("", { status: 423 });
    return new Response("film", { status: 200 });
  }
  return realFetch(url, options);
};

const jpeg = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
const json = (method, url, body) =>
  fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async (url) => (await fetch(base + url)).json();

before(async () => {
  const app = createApp({ store: createStore(dir) });
  films = app.locals.films;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  delete process.env.CLOUDINARY_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a photo is cropped to the display's shape around its subject, inside the photo", () => {
  assert.deepEqual(cropAround({ width: 4000, height: 3000 }, [0.5, 0.5]), { x: 500, y: 0, w: 3000, h: 3000 });
  assert.deepEqual(cropAround({ width: 4000, height: 3000 }, [0.5, 0.05]), { x: 500, y: 0, w: 3000, h: 3000 });
  // A tall photo: the full width, and a band of it around the face.
  assert.deepEqual(cropAround({ width: 3000, height: 4000 }, [0.5, 0.25]), { x: 0, y: 0, w: 3000, h: 3000 });
  assert.deepEqual(cropAround({ width: 3000, height: 4000 }, [0.5, 0.9]), { x: 0, y: 1000, w: 3000, h: 3000 });
});

test("shots last from their moment in the voice message to the next, and a video is not stretched", () => {
  // 30 seconds of voice, photos at 0, 10 and 22: seen for 10, 12 and 8, plus the fade.
  assert.deepEqual(filmSeconds([{ at: 0, type: "image" }, { at: 10, type: "image" }, { at: 22, type: "image" }], 30), [11.5, 13.5, 9.5]);
  // No times: they share the voice message.
  assert.deepEqual(filmSeconds([{ at: null, type: "image" }, { at: null, type: "image" }], 20), [11.5, 11.5]);
  // No voice message: seven seconds each, nine when slower.
  assert.deepEqual(filmSeconds([{ at: null, type: "image" }, { at: null, type: "image" }], null), [8.5, 8.5]);
  assert.deepEqual(filmSeconds([{ at: null, type: "image" }], null, "slower"), [10.5]);
  assert.deepEqual(filmSeconds([{ at: 0, type: "video", duration: 6 }, { at: 20, type: "image" }], 30), [6, 11.5]);
});

test("a tunnel becomes one address: a black opening, then each picture fading into the next", () => {
  const url = filmUrl([
    { id: "memorylane/p1", type: "image", width: 4000, height: 3000, seconds: 11.5, focus: [0.3, 0.4], motion: "push-in" },
    { id: "memorylane/v1", type: "video", width: 1920, height: 1080, seconds: 6, focus: [0.5, 0.45], motion: "still" },
    { id: "memorylane/p2", type: "image", width: 4000, height: 3000, seconds: 9.5, focus: [0.5, 0.5], motion: "push-in" },
  ]);
  assert.equal(
    url,
    "https://res.cloudinary.com/demo/video/upload/du_1.6/c_fill,h_264,w_264/" +
      // A photo before another: held still, cropped around the subject the plan named.
      "fl_splice:transition_(name_fade;du_1.5),l_memorylane:p1/du_11.5/c_crop,h_3000,w_3000,x_0,y_0/c_scale,h_264,w_264/fl_layer_apply/" +
      "fl_splice:transition_(name_fade;du_1.5),l_video:memorylane:v1/du_6/c_fill,h_264,w_264/fl_layer_apply/" +
      // The last photo moves slowly towards its subject.
      "fl_splice:transition_(name_fade;du_1.5),l_memorylane:p2/e_zoompan:du_9.5;fps_25;from_(zoom_1;x_0.5;y_0.5);to_(zoom_1.18;x_0.5;y_0.5)/c_fill,h_264,w_264/fl_layer_apply/" +
      "ac_none,vc_h264,q_auto/memorylane/blank.mp4",
  );
});

test("a hello is silent and the display's size, and a tile's picture is chosen by Cloudinary", () => {
  const clip = { id: "memorylane/v9", type: "video" };
  assert.equal(helloClipUrl(clip), "https://res.cloudinary.com/demo/video/upload/c_fill,h_264,w_264/ac_none,vc_h264,q_auto/memorylane/v9.mp4");
  assert.match(helloClipUrl(clip, { smart: true }), /\/c_fill,g_auto:faces,h_264,w_264\/ac_none,vc_h264,q_auto\//);
  assert.equal(posterUrl(clip), "https://res.cloudinary.com/demo/video/upload/so_auto/c_fill,g_auto,h_480,w_640/f_auto,q_auto/memorylane/v9.jpg");
  assert.match(posterUrl({ id: "memorylane/p9", type: "image" }), /\/image\/upload\/c_fill,g_auto,h_480,w_640\/f_auto,q_auto\/memorylane\/p9\.jpg$/);
});

let memory;

test("a new memory's glasses copy is made by the server, with nobody's page open", async () => {
  const form = new FormData();
  form.append("name", "The lake");
  form.append("from", "Sarah");
  form.append("consentConfirmed", "true");
  form.append("referencePhotos", jpeg(), "object.jpg");
  form.append("memoryPhotos", jpeg(), "one.jpg");
  form.append("memoryPhotos", jpeg(), "two.jpg");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  const created = await fetch(`${base}/api/keepsakes`, { method: "POST", body: form });
  assert.equal(created.status, 201);
  memory = await created.json();
  assert.equal(memory.lane.lensByServer, true);
  assert.equal(memory.lane.lensMaking, true, "the family app is told one is on its way");
  await films.idle();

  const tunnel = await get(`/api/keepsakes/${memory.id}/lane`);
  assert.equal(tunnel.lensMaking, false);
  assert.equal(tunnel.lens.version, tunnel.version);
  assert.match(tunnel.lens.video, /^https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/du_1\.6\/.+\/memorylane\/blank\.mp4$/);
  // Two photos share the 30 seconds of voice; the object's own photo is not in the film.
  assert.equal(tunnel.lens.video.match(/fl_layer_apply/g).length, 2);
  assert.match(tunnel.lens.video, /l_memorylane:a\d+\/du_16\.5\/c_crop/);
  assert.match(tunnel.lens.video, /e_zoompan:du_16\.5/);
  assert.ok(asked.includes(tunnel.lens.video), "the film was asked for, so the glasses do not wait for it");
  // The sound is a copy kept here; the voice message itself is still the memory's.
  assert.match(tunnel.lens.audio, /^\/media\/m_.+\.webm$/);
  assert.notEqual(tunnel.lens.audio, memory.voiceNote);

  // The opening, the voice message (for its length) and the two photos. Not the object's photo.
  const sent = api.filter((call) => call.action === "upload");
  assert.equal(sent.length, 4);
  assert.equal(sent.filter((call) => call.type === "image").length, 2);
  assert.ok(sent.every((call) => /^[0-9a-f]{40}$/.test(call.signature)));

  const pack = await get("/api/pack");
  const packed = pack.keepsakes.find((k) => k.id === memory.id);
  assert.deepEqual(packed.lane.lens, tunnel.lens);
  assert.match(packed.poster, /^https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/c_fill,g_auto,/);
});

test("changing the tunnel makes the copy again without uploading anything twice", async () => {
  const before = await get(`/api/keepsakes/${memory.id}/lane`);
  const uploadsBefore = api.filter((call) => call.action === "upload").length;
  const changed = await (await json("PATCH", `/api/keepsakes/${memory.id}/lane`, { pace: "slower" })).json();
  assert.equal(changed.lensMaking, true);
  await films.idle();
  const after = await get(`/api/keepsakes/${memory.id}/lane`);
  assert.equal(after.lens.version, after.version);
  assert.equal(api.filter((call) => call.action === "upload").length, uploadsBefore);
  // The old copy's sound is gone, the new one is there, and so is the voice message.
  const media = (url) => path.join(dir, "media", path.basename(url));
  assert.ok(!fs.existsSync(media(before.lens.audio)));
  assert.ok(fs.existsSync(media(after.lens.audio)));
  assert.ok(fs.existsSync(media(memory.voiceNote)));

  const again = await json("POST", `/api/keepsakes/${memory.id}/lane/lens/make`);
  assert.equal(again.status, 202);
  await films.idle();
});

test("a memory that is one video is that clip: cropped around its subject, resized and silent", async () => {
  const form = new FormData();
  form.append("name", "The sea");
  form.append("from", "Maya");
  form.append("consentConfirmed", "true");
  form.append("referencePhotos", jpeg(), "object.jpg");
  form.append("clip", new Blob([Buffer.alloc(64, 4)], { type: "video/mp4" }), "sea.mp4");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  const uploadsBefore = api.filter((call) => call.action === "upload").length;
  const sea = await (await fetch(`${base}/api/keepsakes`, { method: "POST", body: form })).json();
  await films.idle();
  const tunnel = await get(`/api/keepsakes/${sea.id}/lane`);
  assert.match(tunnel.lens.video, /\/video\/upload\/c_fill,g_auto,h_264,w_264\/ac_none,vc_h264,q_auto\/memorylane\/a\d+\.mp4$/);
  assert.match(tunnel.lens.audio, /^\/media\/m_.+\.webm$/);
  const plain = asked.findIndex((url) => url.includes("/c_fill,h_264,w_264/ac_none"));
  const smart = asked.findIndex((url) => url.includes("/c_fill,g_auto,h_264,w_264/"));
  assert.ok(plain >= 0 && plain < smart, "the plain crop is on the glasses before the subject is found");
  // Only the clip is uploaded: its own sound is not needed, and the voice message stays here.
  assert.equal(api.filter((call) => call.action === "upload").length - uploadsBefore, 1);
  const packed = (await get("/api/pack")).keepsakes.find((k) => k.id === sea.id);
  assert.match(packed.poster, /\/video\/upload\/so_auto\/c_fill,g_auto,h_480,w_640\//);
  assert.equal(fs.readdirSync(path.join(dir, "media")).filter((f) => f.endsWith(".webm")).length, 4, "one sound per copy, none left over");
});

test("a hello's copy is made from the video: the middle first, then cropped around the faces", async () => {
  const sarah = await (await json("POST", "/api/members", { name: "Sarah", relationship: "Daughter" })).json();
  notReadyYet = 2;
  const form = new FormData();
  form.append("introAudio", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "hello.webm");
  form.append("introVideo", new Blob([Buffer.alloc(64, 4)], { type: "video/mp4" }), "hello.mp4");
  const saved = await (await fetch(`${base}/api/members/${sarah.id}/profile`, { method: "POST", body: form })).json();
  assert.equal(saved.introLensByServer, true);
  assert.equal(saved.introLensMaking, true);
  await films.idle();

  const person = (await get("/api/members")).find((m) => m.id === sarah.id);
  assert.equal(person.introLensMaking, false);
  assert.match(person.introLens.video, /\/video\/upload\/c_fill,g_auto:faces,h_264,w_264\/ac_none,vc_h264,q_auto\/memorylane\/a\d+\.mp4$/);
  assert.match(person.introLens.audio, /^\/media\/m_.+\.webm$/);
  assert.notEqual(person.introLens.audio, person.introAudio);
  assert.match(person.introPoster, /\/video\/upload\/so_auto\/c_fill,g_auto,h_480,w_480\//);
  const smart = asked.findIndex((url) => url.includes("g_auto:faces"));
  const plain = asked.findLastIndex((url, i) => i < smart && url.includes("/c_fill,h_264,w_264/ac_none"));
  assert.ok(plain >= 0, "the plain crop is ready before the faces are found");
  const again = await json("POST", `/api/members/${sarah.id}/hello/make`);
  assert.equal(again.status, 202);
  await films.idle();

  // Taking the video away takes the copy and the upload with it, and leaves the recording.
  const remove = new FormData();
  remove.append("removeIntroVideo", "true");
  const without = await (await fetch(`${base}/api/members/${sarah.id}/profile`, { method: "POST", body: remove })).json();
  assert.equal(without.introLens, null);
  assert.equal(without.introPoster, null);
  assert.equal((await json("POST", `/api/members/${sarah.id}/hello/make`)).status, 409, "nothing to make without a video");
  assert.ok(fs.existsSync(path.join(dir, "media", path.basename(without.introAudio))));
  await films.idle();
  assert.equal(api.filter((call) => call.action === "destroy" && call.type === "video").length, 1);
});

test("removing a memory takes its uploads off Cloudinary", async () => {
  const destroyed = () => api.filter((call) => call.action === "destroy").length;
  const before = destroyed();
  assert.equal((await fetch(`${base}/api/keepsakes/${memory.id}`, { method: "DELETE" })).status, 204);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Two photos and the voice message.
  assert.equal(destroyed() - before, 3);
});
