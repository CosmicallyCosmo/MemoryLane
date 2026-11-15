import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");
const { questionSimilarity } = await import("../src/matching.js");
const { buildSummary } = await import("../src/summary.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-"));
let server;
let base;

// Smallest valid JPEG-ish payload; the rehearsal recogniser never decodes it.
const FRAME = Buffer.alloc(200, 1).toString("base64");
const jpeg = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });

const json = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

function keepsakeForm(overrides = {}) {
  const form = new FormData();
  form.append("name", "Blue teapot");
  form.append("description", "Blue china teapot with a chipped spout");
  form.append("from", "Sarah");
  form.append("story", "You bought this in Whitby in 1974.");
  form.append("consentConfirmed", "true");
  form.append("referencePhotos", jpeg(), "teapot.jpg");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

let keepsakeId;

test("a keepsake cannot be stored without the consent confirmation", async () => {
  const response = await fetch(`${base}/api/keepsakes`, {
    method: "POST",
    body: keepsakeForm({ consentConfirmed: "false" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(fs.readdirSync(path.join(dir, "media")), [], "rejected uploads are removed");
});

test("a keepsake is created with a default intro line", async () => {
  const response = await fetch(`${base}/api/keepsakes`, { method: "POST", body: keepsakeForm() });
  assert.equal(response.status, 201);
  const keepsake = await response.json();
  keepsakeId = keepsake.id;
  assert.equal(keepsake.introLine, "Here's a message Sarah recorded for you.");
  assert.match(keepsake.referencePhotos[0], /^\/media\/m_.+\.jpg$/);
  const photo = await fetch(base + keepsake.referencePhotos[0]);
  assert.equal(photo.status, 200);
});

test("the glasses cannot look until the wearer has agreed", async () => {
  const response = await json("POST", "/api/recognise", { image: FRAME, hint: "teapot" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "consent_required");
});

test("after consent, a look returns the matched keepsake", async () => {
  const profile = await json("PUT", "/api/profile", {
    wearerName: "Jimmy",
    carerName: "Sarah",
    consent: { wearerAgreed: true, agreedBy: "Jimmy", careSignals: true },
  });
  assert.ok((await profile.json()).consent.agreedAt);

  const response = await json("POST", "/api/recognise", { image: FRAME, hint: "teapot" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.matchId, keepsakeId);
  assert.equal(result.keepsake.name, "Blue teapot");
});

test("an unknown object is not logged by name unless the family opted in", async () => {
  await json("POST", "/api/recognise", { image: FRAME });
  let summary = await (await fetch(`${base}/api/summary`)).json();
  assert.equal(summary.looks, 2);
  assert.deepEqual(summary.unknownObjects, []);

  await json("PUT", "/api/profile", { consent: { logUnknownObjects: true } });
  await json("POST", "/api/recognise", { image: FRAME });
  summary = await (await fetch(`${base}/api/summary`)).json();
  assert.equal(summary.unknownObjects.length, 1);
});

test("questions play the family's answer, or admit there is none", async () => {
  const form = new FormData();
  form.append("question", "Who gave me this?");
  form.append("text", "I did, Dad, for your fortieth birthday.");
  form.append("speaker", "Sarah");
  const added = await fetch(`${base}/api/keepsakes/${keepsakeId}/answers`, { method: "POST", body: form });
  assert.equal(added.status, 201);

  const hit = await (await json("POST", "/api/ask", { keepsakeId, question: "who gave this to me" })).json();
  assert.equal(hit.kind, "written");
  assert.equal(hit.say, "Sarah wrote: I did, Dad, for your fortieth birthday.");

  const miss = await (await json("POST", "/api/ask", { keepsakeId, question: "how much is it worth" })).json();
  assert.equal(miss.kind, "none");
  assert.match(miss.say, /I'll let Sarah know you asked/);
});

test("“where did this come from?” is answered from who the family said it is from", async () => {
  const card = await (await fetch(`${base}/api/keepsakes`, { method: "POST", body: keepsakeForm({ name: "Birthday card" }) })).json();
  // Misheard as it was on the glasses, and with nobody having recorded an answer for it.
  for (const question of ["Where did this birthday called come from", "who sent me this", "where is this from"]) {
    const reply = await (await json("POST", "/api/ask", { keepsakeId: card.id, question, confidence: 0.62 })).json();
    assert.equal(reply.kind, "written", question);
    assert.equal(reply.say, "This is from Sarah.");
  }
  // Not about who it is from, and with no memory in view, it is not answered that way.
  assert.equal((await (await json("POST", "/api/ask", { keepsakeId: card.id, question: "who came to my party" })).json()).kind, "none");
  assert.equal((await (await json("POST", "/api/ask", { question: "where did this come from" })).json()).kind, "none");
  await fetch(`${base}/api/keepsakes/${card.id}`, { method: "DELETE" });
});

test("a question repeated three times in half an hour becomes a nudge", async () => {
  for (let i = 0; i < 2; i++) await json("POST", "/api/ask", { keepsakeId, question: "Who gave me this?" });
  const summary = await (await fetch(`${base}/api/summary`)).json();
  assert.equal(summary.nudges.length, 1);
  assert.equal(summary.nudges[0].timesInHalfHour, 3);
  assert.equal(summary.unansweredQuestions[0].question, "how much is it worth");
});

test("the phone can only report known event types", async () => {
  const response = await json("POST", "/api/events", {
    events: [{ type: "privacy_pause" }, { type: "look", matchId: "forged" }, { type: "nonsense" }],
  });
  assert.equal((await response.json()).stored, 1);
});

test("the pack carries everything for offline use and its version tracks changes", async () => {
  const first = await (await fetch(`${base}/api/pack`)).json();
  assert.equal(first.keepsakes[0].answers.length, 1);
  assert.equal(first.profile.wearerName, "Jimmy");
  await json("PUT", "/api/profile", { wearerName: "Jim" });
  const second = await (await fetch(`${base}/api/pack`)).json();
  assert.notEqual(first.version, second.version);
});

test("deleting a keepsake removes its files, and the log can be wiped", async () => {
  assert.equal((await json("DELETE", `/api/keepsakes/${keepsakeId}`)).status, 204);
  assert.deepEqual(fs.readdirSync(path.join(dir, "media")), []);
  assert.equal((await json("DELETE", "/api/events")).status, 204);
  assert.equal((await (await fetch(`${base}/api/summary`)).json()).looks, 0);
});

test("question similarity tolerates rewording but not a different question", () => {
  assert.ok(questionSimilarity("Who gave me this?", "who gave this to me") >= 0.6);
  assert.ok(questionSimilarity("Who gave me this?", "how much is it worth") < 0.3);
});

test("repeats spread over days are not a nudge", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const events = [0, 1, 2].map((d) => ({
    type: "question",
    keepsakeId: "k1",
    question: "Who gave me this?",
    answerId: "a1",
    at: new Date(now - d * 24 * 60 * 60 * 1000).toISOString(),
  }));
  assert.deepEqual(buildSummary({ events, keepsakes: [], now }).nudges, []);
});

test("photos of the object can be added to a memory, up to eight", async () => {
  const created = await (await fetch(base + "/api/keepsakes", { method: "POST", body: keepsakeForm({ name: "Brass bell" }) })).json();
  const photos = (count) => {
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append("referencePhotos", jpeg(), `close-up-${i}.jpg`);
    return form;
  };
  const add = (id, form) => fetch(`${base}/api/keepsakes/${id}/photos`, { method: "POST", body: form });

  const added = await add(created.id, photos(2));
  assert.equal(added.status, 200);
  const keepsake = await added.json();
  assert.equal(keepsake.referencePhotos.length, created.referencePhotos.length + 2);
  assert.equal(keepsake.referencePhotos[0], created.referencePhotos[0]);
  assert.equal(keepsake.mightBeMistaken, false);

  assert.equal((await add(created.id, new FormData())).status, 400);
  assert.equal((await add("k_missing", photos(1))).status, 404);
  // A recording or video is not a photo of the object: every look would be refused with it.
  const video = new FormData();
  video.append("referencePhotos", new Blob([Buffer.alloc(16)], { type: "video/mp4" }), "clip.mp4");
  const refused = await add(created.id, video);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /must be pictures/);
  const asNew = keepsakeForm({ name: "Odd one" });
  asNew.append("referencePhotos", new Blob([Buffer.alloc(16)], { type: "audio/webm" }), "note.webm");
  assert.equal((await fetch(base + "/api/keepsakes", { method: "POST", body: asNew })).status, 400);
  // Three, plus two more, plus four would be nine.
  await add(created.id, photos(2));
  const tooMany = await add(created.id, photos(4));
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /up to 8/);
  const listed = await (await fetch(base + "/api/keepsakes")).json();
  assert.equal(listed.find((k) => k.id === created.id).referencePhotos.length, created.referencePhotos.length + 4);
});
