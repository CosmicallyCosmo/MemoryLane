import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
delete process.env.CLOUDINARY_URL;
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-lane-"));
let server;
let base;
let jake;

const clip = (year, title, type = "video/mp4", name = "clip.mp4") => {
  const form = new FormData();
  form.append("video", new Blob([Buffer.alloc(64, 1)], { type }), name);
  if (year !== undefined) form.append("year", String(year));
  if (title !== undefined) form.append("title", title);
  return fetch(`${base}/api/members/${jake.id}/lane`, { method: "POST", body: form });
};

before(async () => {
  const app = createApp({ store: createStore(dir) });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  jake = await (
    await fetch(`${base}/api/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Jake Ward", relationship: "Son" }) })
  ).json();
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a person with no clips has no memory lane", async () => {
  assert.equal(jake.lane, null);
  const lane = await (await fetch(`${base}/api/members/${jake.id}/lane`)).json();
  assert.deepEqual(lane.memories, []);
});

test("clips are kept in order of year, and reach the glasses", async () => {
  assert.equal((await clip(2020, "Graduation day")).status, 201);
  const lane = await (await clip(1998, "The day you came home")).json();
  assert.deepEqual(lane.memories.map((m) => m.year), [1998, 2020]);
  assert.match(lane.memories[0].src, /^\/media\/m_.+\.mp4$/);

  const pack = await (await fetch(`${base}/api/pack`)).json();
  const person = pack.people.find((p) => p.id === jake.id);
  assert.equal(person.lane.count, 2);
  assert.equal(person.lane.clips[0].title, "The day you came home");
});

test("a clip needs a video, a year and a title", async () => {
  assert.equal((await clip(undefined, "No year")).status, 400);
  assert.equal((await clip(2001, " ")).status, 400);
  assert.equal((await clip(2001, "A photo", "image/jpeg", "photo.jpg")).status, 400);
  const lane = await (await fetch(`${base}/api/members/${jake.id}/lane`)).json();
  assert.equal(lane.memories.length, 2);
  // Nothing refused is left behind in the media folder.
  assert.equal(fs.readdirSync(path.join(dir, "media")).length, 2);
});

test("the walk-through page is served with that person's clips", async () => {
  const page = await fetch(`${base}/lane/${jake.id}/memory-lane.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /crossOrigin = "anonymous"[\s\S]*<script src="memories\.js">/);
  const list = await (await fetch(`${base}/lane/${jake.id}/memories.js`)).text();
  assert.match(list, /^window\.MEMORY_LANE = \{"name":"Jake"/);
  assert.match(list, /"year":1998,"title":"The day you came home","src":"\/media\//);
  assert.equal((await fetch(`${base}/lane/nobody/memory-lane.html`)).status, 404);
});

test("a clip can be removed, and its file goes with it", async () => {
  const before = await (await fetch(`${base}/api/members/${jake.id}/lane`)).json();
  const after = await (await fetch(`${base}/api/members/${jake.id}/lane/${before.memories[0].id}`, { method: "DELETE" })).json();
  assert.deepEqual(after.memories.map((m) => m.title), ["Graduation day"]);
  assert.equal(fs.readdirSync(path.join(dir, "media")).length, 1);
});
