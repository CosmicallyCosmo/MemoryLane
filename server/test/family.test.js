import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-family-"));
let server;
let base;
const FRAME = Buffer.alloc(200, 1).toString("base64");
const jpeg = () => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
const json = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = async (url) => (await fetch(base + url)).json();

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

let sarah;
let tom;
let keepsakeId;

test("the first member organises, later ones contribute, and names are unique", async () => {
  sarah = await (await json("POST", "/api/members", { name: "Sarah", relationship: "Daughter" })).json();
  tom = await (await json("POST", "/api/members", { name: "Tom", relationship: "Grandson" })).json();
  assert.equal(sarah.role, "organiser");
  assert.equal(tom.role, "contributor");
  assert.equal((await json("POST", "/api/members", { name: "sarah" })).status, 400);
});

test("the last organiser cannot step down or be removed while others remain", async () => {
  assert.equal((await json("PATCH", `/api/members/${sarah.id}`, { role: "contributor" })).status, 400);
  assert.equal((await json("DELETE", `/api/members/${sarah.id}`)).status, 400);
});

test("adding a keepsake tells the rest of the family, not the person who added it", async () => {
  const form = new FormData();
  form.append("name", "Blue teapot");
  form.append("consentConfirmed", "true");
  form.append("addedBy", tom.id);
  form.append("referencePhotos", jpeg(), "teapot.jpg");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  const keepsake = await (await fetch(`${base}/api/keepsakes`, { method: "POST", body: form })).json();
  keepsakeId = keepsake.id;
  assert.equal(keepsake.addedBy, tom.id);

  const forSarah = await get(`/api/notifications?member=${sarah.id}`);
  assert.ok(forSarah.notifications.some((n) => n.type === "keepsake_added" && /Tom added a memory/.test(n.title)));
  const forTom = await get(`/api/notifications?member=${tom.id}`);
  assert.ok(!forTom.notifications.some((n) => n.type === "keepsake_added"));
});

test("nothing about the wearer becomes a notice until care signals are switched on", async () => {
  await json("PUT", "/api/profile", { wearerName: "Jimmy", consent: { wearerAgreed: true } });
  await json("POST", "/api/recognise", { image: FRAME, hint: "teapot" });
  await json("POST", "/api/ask", { keepsakeId, question: "How much is it worth?" });
  let notices = (await get(`/api/notifications?member=${sarah.id}`)).notifications;
  assert.ok(!notices.some((n) => ["memory_played", "unanswered"].includes(n.type)));

  await json("PUT", "/api/profile", { consent: { careSignals: true } });
  await json("POST", "/api/recognise", { image: FRAME, hint: "teapot" });
  await json("POST", "/api/ask", { keepsakeId, question: "How much is it worth?" });
  await json("POST", "/api/ask", { keepsakeId, question: "how much is it worth" });
  notices = (await get(`/api/notifications?member=${sarah.id}`)).notifications;
  assert.equal(notices.filter((n) => n.type === "memory_played").length, 1);
  assert.equal(notices.filter((n) => n.type === "unanswered").length, 1, "the same question is not announced twice");
});

test("a repeated question raises one check-in notice", async () => {
  await json("POST", "/api/ask", { keepsakeId, question: "How much is it worth?" });
  await json("POST", "/api/ask", { keepsakeId, question: "How much is it worth?" });
  const notices = (await get(`/api/notifications?member=${sarah.id}`)).notifications;
  assert.equal(notices.filter((n) => n.type === "repeat").length, 1);
});

test("one relative can ask another to record an answer, and only they see it", async () => {
  const sent = await json("POST", "/api/notifications/request", {
    forMember: tom.id,
    fromMember: sarah.id,
    keepsakeId,
    question: "How much is it worth?",
  });
  assert.equal(sent.status, 201);
  assert.ok((await get(`/api/notifications?member=${tom.id}`)).notifications.some((n) => n.type === "request"));
  assert.ok(!(await get(`/api/notifications?member=${sarah.id}`)).notifications.some((n) => n.type === "request"));
});

test("reading is tracked per person", async () => {
  await json("POST", "/api/notifications/read", { member: sarah.id, all: true });
  assert.equal((await get(`/api/notifications?member=${sarah.id}`)).unread, 0);
  assert.ok((await get(`/api/notifications?member=${tom.id}`)).unread > 0);
});

test("answers are credited, and the stats show who contributed and what was heard", async () => {
  const form = new FormData();
  form.append("question", "How much is it worth?");
  form.append("text", "More to us than to anyone else.");
  form.append("speaker", "Sarah");
  form.append("addedBy", sarah.id);
  await fetch(`${base}/api/keepsakes/${keepsakeId}/answers`, { method: "POST", body: form });
  await json("POST", "/api/ask", { keepsakeId, question: "How much is it worth?" });

  const stats = await get("/api/stats?days=7");
  assert.equal(stats.totals.memoriesPlayed, 2);
  assert.equal(stats.totals.questionsAsked, 5);
  assert.equal(stats.totals.questionsAnswered, 1);
  assert.equal(stats.hourly.length, 24);
  assert.equal(stats.keepsakes[0].addedByName, "Tom");
  const byName = Object.fromEntries(stats.members.map((m) => [m.name, m]));
  assert.equal(byName.Tom.keepsakesAdded, 1);
  assert.equal(byName.Sarah.answersRecorded, 1);
  assert.equal(byName.Tom.timesHeard, 2);
  assert.equal(byName.Sarah.timesHeard, 1);
});

test("the activity feed reads as sentences, newest first", async () => {
  const activity = await get("/api/activity?limit=5");
  assert.match(activity[0].text, /Jimmy asked “How much is it worth\?” about the Blue teapot and heard the family's answer\./);
});

test("a keepsake's words can be edited", async () => {
  const edited = await (await json("PATCH", `/api/keepsakes/${keepsakeId}`, { story: "From Whitby, 1974." })).json();
  assert.equal(edited.story, "From Whitby, 1974.");
  assert.equal(edited.name, "Blue teapot");
});

test("wiping the history removes what was learned about the wearer but keeps family news", async () => {
  await json("DELETE", "/api/events");
  const notices = (await get(`/api/notifications?member=${sarah.id}`)).notifications;
  assert.ok(!notices.some((n) => ["memory_played", "unanswered", "repeat"].includes(n.type)));
  assert.ok(notices.some((n) => n.type === "keepsake_added"));
});
