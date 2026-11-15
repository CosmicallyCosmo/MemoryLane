import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "rehearsal";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-profiles-"));
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
  await json("PUT", "/api/profile", {
    wearerName: "Jimmy",
    carerName: "Anna",
    consent: { wearerAgreed: true, careSignals: true },
  });
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let sarah;

test("a profile holds a photo and the person's own introduction", async () => {
  sarah = await (await json("POST", "/api/members", { name: "Sarah", relationship: "Daughter" })).json();
  const form = new FormData();
  form.append("photo", jpeg(), "sarah.jpg");
  form.append("introText", "It's Sarah, your daughter. I visit on Sundays.");
  const saved = await (await fetch(`${base}/api/members/${sarah.id}/profile`, { method: "POST", body: form })).json();
  assert.match(saved.photo, /^\/media\/m_.+\.jpg$/);
  assert.equal(saved.introText, "It's Sarah, your daughter. I visit on Sundays.");
});

test("an everyday question with no answer goes to the family, and is answered from then on", async () => {
  const first = await (await json("POST", "/api/ask", { question: "Where is Margaret?" })).json();
  assert.equal(first.kind, "none");
  assert.match(first.say, /I'll let Anna know you asked/);
  await json("POST", "/api/ask", { question: "where is margaret" });

  const inbox = await get("/api/questions");
  assert.equal(inbox.open.length, 1);
  assert.equal(inbox.open[0].count, 2);
  assert.equal(inbox.open[0].keepsakeId, null);
  const notices = (await get(`/api/notifications?member=${sarah.id}`)).notifications;
  assert.ok(notices.some((n) => n.type === "unanswered" && /Where is Margaret/.test(n.body)));

  const form = new FormData();
  form.append("question", "Where is Margaret?");
  form.append("text", "Mum is at her sister's this week. She'll be home on Friday.");
  form.append("speaker", "Sarah");
  form.append("addedBy", sarah.id);
  assert.equal((await fetch(`${base}/api/questions`, { method: "POST", body: form })).status, 201);

  const next = await (await json("POST", "/api/ask", { question: "Where is Margaret?" })).json();
  assert.equal(next.kind, "written");
  assert.equal(next.say, "Sarah wrote: Mum is at her sister's this week. She'll be home on Friday.");

  const after = await get("/api/questions");
  assert.equal(after.open.length, 0, "an answered question is no longer waiting");
  assert.equal(after.answered[0].timesUsed, 1);

  // A different question that happens to start the same way must not get this answer.
  const other = await (await json("POST", "/api/ask", { question: "Where am I?" })).json();
  assert.equal(other.kind, "none");
  assert.equal(after.answered[0].addedByName, "Sarah");
});

test("a memory can say who is in it, so a framed photograph answers “who is that?”", async () => {
  const form = new FormData();
  form.append("name", "Photo on the mantelpiece");
  form.append("consentConfirmed", "true");
  form.append("addedBy", sarah.id);
  form.append("people", sarah.id);
  form.append("referencePhotos", jpeg(), "frame.jpg");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  const memory = await (await fetch(`${base}/api/keepsakes`, { method: "POST", body: form })).json();
  assert.deepEqual(memory.people, [sarah.id]);

  const seen = await (await json("POST", "/api/recognise", { image: FRAME, hint: "mantelpiece" })).json();
  assert.equal(seen.matchId, memory.id);
  assert.equal(seen.person.name, "Sarah");
  assert.equal(seen.person.introText, "It's Sarah, your daughter. I visit on Sundays.");
});

test("with more than one person in a memory, “who is that?” is the one whose memory it is", async () => {
  const tom = await (await json("POST", "/api/members", { name: "Tom", relationship: "Son" })).json();
  const form = new FormData();
  form.append("name", "Seaside postcard");
  form.append("consentConfirmed", "true");
  form.append("addedBy", sarah.id);
  form.append("people", `${tom.id},${sarah.id}`);
  form.append("referencePhotos", jpeg(), "postcard.jpg");
  form.append("voiceNote", new Blob([Buffer.alloc(64, 1)], { type: "audio/webm" }), "voice.webm");
  const memory = await (await fetch(`${base}/api/keepsakes`, { method: "POST", body: form })).json();

  const seen = await (await json("POST", "/api/recognise", { image: FRAME, hint: "seaside postcard" })).json();
  assert.equal(seen.matchId, memory.id);
  assert.equal(seen.person.name, "Sarah");
});

test("nobody is ever recognised by their face", async () => {
  // Looking at Sarah herself, not at a memory, never names her, whatever is asked for.
  await json("PUT", "/api/profile", { consent: { recognisePeople: true } });
  assert.ok(!("recognisePeople" in (await get("/api/profile")).consent), "there is no such choice to make");
  const seen = await (await json("POST", "/api/recognise", { image: FRAME, hint: "Sarah" })).json();
  assert.equal(seen.matchId, null);
  assert.equal(seen.person, null);
  assert.ok(!("recognisesPeople" in (await get("/api/health"))));
});

test("what an older version stored for recognising faces is dropped", () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-faces-"));
  fs.writeFileSync(
    path.join(old, "db.json"),
    JSON.stringify({
      profile: { wearerName: "Jimmy", consent: { wearerAgreed: true, recognisePeople: true } },
      members: [{ id: "p_1", name: "Sarah", recognitionConsent: true, recognitionConsentAt: "2026-11-01T00:00:00.000Z" }],
      consentLog: [
        { at: "2026-11-01T00:00:00.000Z", what: "recognisePeople", on: true },
        { at: "2026-11-01T00:00:00.000Z", what: "recognitionConsent", on: true, member: "p_1" },
        { at: "2026-11-01T00:00:00.000Z", what: "careSignals", on: true },
      ],
    }),
  );
  const loaded = createStore(old);
  assert.deepEqual(loaded.profile.consent.wearerAgreed, true);
  assert.ok(!("recognisePeople" in loaded.profile.consent));
  assert.deepEqual(Object.keys(loaded.members[0]), ["id", "name"]);
  assert.deepEqual(loaded.consentLog.map((entry) => entry.what), ["careSignals"]);
  fs.rmSync(old, { recursive: true, force: true });
});

test("the offline pack carries the people and the everyday answers", async () => {
  const pack = await get("/api/pack");
  assert.equal(pack.people[0].name, "Sarah");
  assert.equal(pack.answers[0].question, "Where is Margaret?");
  assert.ok(!("role" in pack.people[0]), "the glasses do not need family roles or statistics");
});

test("the consent page shows every agreement and who changed it", async () => {
  const member = await (await json("POST", "/api/members", { name: "Consent Tester", relationship: "nephew" })).json();
  await json("PUT", "/api/profile", { consent: { logUnknownObjects: true }, changedBy: member.id });
  // Setting a value it already has is not a change.
  await json("PUT", "/api/profile", { consent: { logUnknownObjects: true }, changedBy: member.id });
  // An unknown member is not credited.
  await json("PUT", "/api/profile", { consent: { logUnknownObjects: false }, changedBy: "p_nobody" });

  const consent = await get("/api/consent");
  assert.equal(consent.wearer.agreed, true);
  assert.equal(consent.choices.logUnknownObjects, false);
  assert.ok(!("faces" in consent));

  const [off, on] = consent.history;
  assert.deepEqual([off.what, off.on, off.by], ["logUnknownObjects", false, null]);
  assert.deepEqual([on.what, on.on, on.byName], ["logUnknownObjects", true, "Consent Tester"]);
  assert.equal(consent.history.filter((entry) => entry.what === "logUnknownObjects").length, 2);
});
