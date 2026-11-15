import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");
const { cleanSession, describeHeart, summarise, typical } = await import("../src/heart.js");

const flat = (bpm, count = 20) => Array.from({ length: count }, () => bpm);
/** Resting, then a rise that holds, then back down. */
const rise = (from, to) => [...flat(from, 8), ...flat(to, 8), ...flat(from + 2, 6)];

test("a held rise above resting is a rise, and says when it came", () => {
  const summary = summarise(cleanSession({ restingBpm: 68, everySec: 2, samples: rise(68, 82) }));
  assert.equal(summary.kind, "lifted");
  assert.equal(summary.peakBpm, 82);
  assert.equal(summary.changeBpm, 14);
  assert.ok(summary.peakAtSec >= 16 && summary.peakAtSec <= 30);
  assert.match(describeHeart(summary, "Jimmy"), /^Jimmy's heart rate rose from 68 to 82 beats a minute, about \d+ seconds in\.$/);
});

test("one stray reading is not a rise", () => {
  const samples = flat(70);
  samples[9] = 110;
  assert.equal(summarise(cleanSession({ restingBpm: 70, samples })).kind, "steady");
});

test("an average well below resting is easing, and a small change is steady", () => {
  const eased = summarise(cleanSession({ restingBpm: 78, samples: flat(71) }));
  assert.equal(eased.kind, "settled");
  assert.equal(eased.changeBpm, -7);
  assert.match(describeHeart(eased, ""), /^Their heart rate fell from 78 to around 71/);
  assert.equal(summarise(cleanSession({ restingBpm: 70, samples: flat(73) })).kind, "steady");
});

test("sessions that are too short, out of range or malformed are refused", () => {
  assert.equal(cleanSession({ restingBpm: 70, samples: [70, 71] }), null);
  assert.equal(cleanSession({ restingBpm: 70, samples: [...flat(70), 400] }), null);
  assert.equal(cleanSession({ restingBpm: 5, samples: flat(70) }), null);
  assert.equal(cleanSession({ restingBpm: 70, samples: "70,70,70,70,70" }), null);
  assert.equal(cleanSession(null), null);
  assert.equal(cleanSession({ restingBpm: 70, samples: flat(70, 900) }).samples.length, 300);
  assert.equal(cleanSession({ restingBpm: 70, samples: flat(70), source: "made up" }).source, "glasses");
});

test("typical counts the rises and averages how far above resting the peak was", () => {
  const all = [rise(68, 82), flat(70), rise(70, 80)].map((samples, i) => summarise(cleanSession({ restingBpm: [68, 70, 70][i], samples })));
  assert.deepEqual(typical(all), { sessions: 3, lifted: 2, settled: 0, simulated: 0, averageRise: 12, lastKind: "lifted" });
  assert.equal(typical([]), null);
});

// ---- Through the server ----------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-heart-"));
let server;
let base;
let store;
const json = (method, url, body) =>
  fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async (url) => (await fetch(base + url)).json();
let keepsakeId;
const send = (heart, id = keepsakeId) => json("POST", "/api/events", { events: [{ type: "heart_response", keepsakeId: id, heart }] }).then((r) => r.json());

before(async () => {
  store = createStore(dir);
  await new Promise((resolve) => {
    server = createApp({ store }).listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const form = new FormData();
  form.append("name", "Blue teapot");
  form.append("consentConfirmed", "true");
  form.append("referencePhotos", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "teapot.jpg");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  keepsakeId = (await (await fetch(`${base}/api/keepsakes`, { method: "POST", body: form })).json()).id;
  await json("PUT", "/api/profile", { wearerName: "Jimmy", consent: { wearerAgreed: true } });
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("heart rate is not kept until the family switches it on", async () => {
  assert.equal((await send({ restingBpm: 68, samples: rise(68, 82) })).stored, 0);
  const heart = await get(`/api/keepsakes/${keepsakeId}/heart`);
  assert.deepEqual([heart.enabled, heart.sessions.length, heart.typical], [false, 0, null]);
  assert.equal((await get("/api/stats")).heartRate, false);
});

test("once on, a session is kept, summarised, listed in the activity and tells the family", async () => {
  await json("PUT", "/api/profile", { consent: { heartRate: true } });
  assert.equal((await send({ restingBpm: 68, everySec: 2, samples: rise(68, 82), source: "simulated" })).stored, 1);
  assert.equal((await send({ restingBpm: 70, samples: flat(71) })).stored, 1);
  // Not a session, and not a memory: both dropped.
  assert.equal((await send({ restingBpm: 70, samples: [70] })).stored, 0);
  assert.equal((await send({ restingBpm: 70, samples: flat(71) }, "k_nothing")).stored, 0);

  const heart = await get(`/api/keepsakes/${keepsakeId}/heart`);
  assert.equal(heart.enabled, true);
  assert.deepEqual(heart.sessions.map((s) => s.kind), ["steady", "lifted"]);
  assert.equal(heart.sessions[1].source, "simulated");
  assert.equal(heart.sessions[1].samples.length, 22);
  assert.deepEqual([heart.typical.sessions, heart.typical.lifted], [2, 1]);

  const stats = await get("/api/stats");
  assert.equal(stats.heartRate, true);
  assert.equal(stats.keepsakes.find((k) => k.id === keepsakeId).heart.sessions, 2);

  const activity = await get(`/api/activity?keepsake=${keepsakeId}`);
  assert.ok(activity.some((item) => item.kind === "heart" && /rose from 68 to 82/.test(item.text)));

  const notices = (await get("/api/notifications")).notifications.filter((n) => n.type === "heart_lifted");
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /from 68 to 82 beats a minute while the Blue teapot was open/);
  assert.equal((await get("/api/consent")).history[0].what, "heartRate");
});

test("switching it off deletes what was kept, and nothing else", async () => {
  await json("POST", "/api/events", { events: [{ type: "memory_replayed", keepsakeId }] });
  await json("PUT", "/api/profile", { consent: { heartRate: false } });
  assert.ok(!store.events.some((e) => e.type === "heart_response"));
  assert.ok(store.events.some((e) => e.type === "memory_replayed"));
  assert.ok(!(await get("/api/notifications")).notifications.some((n) => n.type === "heart_lifted"));
  assert.equal((await get(`/api/keepsakes/${keepsakeId}/heart`)).sessions.length, 0);
  assert.equal((await get("/api/keepsakes/k_nothing/heart")).error, "Not found.");
});
