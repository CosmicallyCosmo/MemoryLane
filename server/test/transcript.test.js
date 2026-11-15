// A voice message written down by Gemini, against a stand-in for the Gemini API: it is offered
// to the family as a draft and never saved for them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.ML_RECOGNISER = "gemini";
process.env.GEMINI_API_KEY = "test-key";
process.env.ML_GEMINI_MODEL = "stand-in";
// A stand-in that answers 503 is tried again until the time is up: keep that short here.
process.env.ML_LANE_TIMEOUT_MS = "2000";
process.env.ML_TRANSCRIPT_TIMEOUT_MS = "2000";
const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-transcript-"));
let server;
let base;
let store;

const realFetch = globalThis.fetch;
let reply = () => ({ status: 500, body: {} });
const sent = [];
globalThis.fetch = async (url, options) => {
  if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, options);
  const body = JSON.parse(options.body);
  sent.push(body);
  const { status, body: answer } = reply(body);
  return new Response(status === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) : "unavailable", { status });
};

async function addMemory() {
  const form = new FormData();
  form.append("name", "Keyring");
  form.append("consentConfirmed", "true");
  form.append("referencePhotos", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "keyring.jpg");
  form.append("voiceNote", new Blob([Buffer.from("not really sound")], { type: "audio/mpeg" }), "hello.mp3");
  const response = await realFetch(`${base}/api/keepsakes`, { method: "POST", body: form });
  assert.equal(response.status, 201);
  return response.json();
}
const transcript = (id) => realFetch(`${base}/api/keepsakes/${id}/transcript`, { method: "POST" });

before(async () => {
  store = createStore(dir);
  server = await new Promise((resolve) => {
    const s = createApp({ store }).listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a voice message is written down from the recording itself, and nothing is saved", async () => {
  const memory = await addMemory();
  sent.length = 0;
  reply = () => ({ status: 200, body: { transcript: "  Hi Mum, it's Maya. That's the keyring from Sri Lanka.  " } });
  const response = await transcript(memory.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "Hi Mum, it's Maya. That's the keyring from Sri Lanka." });
  // The recording was what the model was given.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].contents[0].parts[0].inlineData.mimeType, "audio/mp3");
  // The family saves it themselves, after reading it.
  assert.equal(store.keepsake(memory.id).story, "");
});

test("no words, or no answer, is said plainly and offers nothing", async () => {
  const memory = await addMemory();
  reply = () => ({ status: 200, body: { transcript: "" } });
  assert.equal((await transcript(memory.id)).status, 422);
  reply = () => ({ status: 500, body: {} });
  const failed = await transcript(memory.id);
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /type it/);
  assert.equal((await transcript("k_missing")).status, 404);
});
