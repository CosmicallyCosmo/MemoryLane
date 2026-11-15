// Recognition through the Gemini Decisions API, against a stand-in for it: what is sent, how a
// choice is confirmed against the chosen keepsake alone, how a miss is named, and how each
// keepsake is prepared (features, checks and a look-alike self-test).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";

process.env.ML_RECOGNISER = "gemini";
process.env.GEMINI_API_KEY = "test-key";
process.env.ML_PREPARE_GAP_MS = "0";
// The Decisions API is the default with Gemini; nothing sets ML_GEMINI_DECISIONS here.
delete process.env.ML_GEMINI_DECISIONS;
delete process.env.ML_MIN_CONFIDENCE;
const { recogniseKeepsake, prepareKeepsakes } = await import("../src/ai.js");

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-decisions-"));
for (const name of ["a.jpg", "b.jpg", "c.jpg"]) fs.writeFileSync(path.join(mediaDir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const keepsakes = [
  {
    id: "k_teapot",
    name: "Mum's teapot",
    description: "Blue flowers.",
    features: "A round teapot with a chipped spout.",
    checks: ["The spout is chipped.", "Blue flowers on the lid."],
    referencePhotos: ["a.jpg", "b.jpg"],
  },
  { id: "k_medal", name: "Grandad's medal", referencePhotos: ["c.jpg"] },
];

const DECISIONS = "https://generativelanguage.googleapis.com/v1beta/decisions";
// The stand-in answers each kind of request from its own reply: the choice among keepsakes,
// the confirmation against one, the vision model (labels, descriptions), the image model.
const replies = {};
const sent = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  sent.push({ url: String(url), body });
  const kind =
    String(url) === DECISIONS
      ? body.questions.keepsake
        ? "choose"
        : "confirm"
      : /image:generateContent$/.test(String(url))
        ? "image"
        : "vision";
  const reply = typeof replies[kind] === "function" ? replies[kind](body) : replies[kind];
  const { status = 200, body: out } = reply;
  return new Response(JSON.stringify(out), { status });
};
const decisionsOf = (kind) => sent.filter((s) => s.url === DECISIONS && (kind === "choose") === Boolean(s.body.questions.keepsake));
const visionSays = (fields) => ({ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }] } });
const choice = (probabilities) => {
  const pick = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: "choice", choice: pick, probabilities, confidence: probabilities[pick] };
};
const chooses = (probabilities) => ({ body: { answers: { keepsake: choice(probabilities) } } });
/** "Same object" at `same`; each check answered "no" at `no`. */
const confirms = (same, no = 0.01) => (body) => ({
  body: {
    answers: Object.fromEntries(
      Object.keys(body.questions).map((key) => [
        key,
        key === "same" ? choice({ same, different: 1 - same }) : choice({ yes: 1 - no - 0.01, no, unseen: 0.01 }),
      ]),
    ),
  },
});
const look = () => recogniseKeepsake({ frameBase64: "frame".repeat(30), keepsakes, mediaDir });

test("each keepsake is a numbered option, its name, features and photos together, then the frame", async () => {
  replies.choose = chooses({ k_teapot: 0.97, k_medal: 0.02, other: 0.01 });
  replies.confirm = confirms(0.9);
  sent.length = 0;
  assert.deepEqual(await look(), { matchId: "k_teapot", confidence: 0.97, objectLabel: "", reason: undefined });

  const [{ body }] = decisionsOf("choose");
  assert.equal(body.model, "gemini-decision-1");
  const kinds = body.input.map((block) => (block.type === "image" ? "image" : block.text.trim().split("\n")[0]));
  assert.deepEqual(kinds, [
    kinds[0],
    'Option 1: "Mum\'s teapot".',
    "image",
    "image",
    "End of option 1.",
    'Option 2: "Grandad\'s medal".',
    "image",
    "End of option 2.",
    "The frame from the glasses:",
    "image",
  ]);
  assert.match(body.input[1].text, /Identifying features of option 1: Blue flowers\. A round teapot with a chipped spout\./);
  // No features yet: no features line, rather than an empty one.
  assert.doesNotMatch(body.input[5].text, /Identifying features/);
  const { criteria } = body.questions.keepsake;
  assert.deepEqual(Object.keys(criteria), ["k_teapot", "k_medal", "other"]);
  assert.match(criteria.k_teapot, /^Option 1, "Mum's teapot": .*under option 1.*chipped spout/);
  // A match needs no label, so the vision model is not asked.
  assert.equal(sent.filter((s) => s.url !== DECISIONS).length, 0);
});

test("a match is confirmed against the chosen keepsake alone: its photos, the frame, and its checks", async () => {
  replies.choose = chooses({ k_teapot: 0.97, k_medal: 0.02, other: 0.01 });
  replies.confirm = confirms(0.9);
  sent.length = 0;
  await look();

  const [{ body }] = decisionsOf("confirm");
  // The teapot's two photos and the frame; nothing of the medal.
  assert.equal(body.input.filter((block) => block.type === "image").length, 3);
  assert.equal(body.input.at(-1).data, "frame".repeat(30));
  assert.doesNotMatch(JSON.stringify(body.input), /medal/i);
  assert.deepEqual(Object.keys(body.questions), ["same", "check0", "check1"]);
  assert.match(body.questions.check0.instructions, /The spout is chipped\./);
});

test("a choice the confirmation does not back is no match, and the object is named", async () => {
  replies.choose = chooses({ k_teapot: 0.99, k_medal: 0.005, other: 0.005 });
  replies.vision = visionSays({ match_id: "none", confidence: 0.9, object_label: "a white teapot" });

  // Measured: a look-alike scored 0.993 on the choice, and 0.42 or less on "the same object".
  replies.confirm = confirms(0.42);
  assert.deepEqual(await look(), { matchId: null, confidence: 0.99, objectLabel: "a white teapot", reason: "not_confirmed" });

  // Called the same object, but one of its checks is clearly not true of it.
  replies.confirm = confirms(0.9, 0.85);
  assert.equal((await look()).reason, "not_confirmed");

  replies.confirm = confirms(0.9, 0.3);
  assert.equal((await look()).matchId, "k_teapot");
});

test("a confirmation that cannot be had fails the look, rather than letting the match through", async () => {
  replies.choose = chooses({ k_teapot: 0.97, k_medal: 0.02, other: 0.01 });
  replies.confirm = { status: 503, body: { error: { message: "overloaded" } } };
  await assert.rejects(look(), /Gemini Decisions 503/);
});

test("a reference photo is sent at 512 px at most, and the original is left as it was", async () => {
  const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(mediaDir, "big.jpg"), big);
  replies.choose = chooses({ k_big: 0.99, other: 0.01 });
  replies.confirm = confirms(0.9);
  sent.length = 0;
  await recogniseKeepsake({ frameBase64: "frame".repeat(30), keepsakes: [{ id: "k_big", name: "Big", referencePhotos: ["big.jpg"] }], mediaDir });

  for (const { body } of [...decisionsOf("choose"), ...decisionsOf("confirm")]) {
    const photo = body.input.find((block) => block.type === "image");
    const { width, height } = await sharp(Buffer.from(photo.data, "base64")).metadata();
    assert.deepEqual([width, height], [512, 384]);
  }
  assert.deepEqual(fs.readFileSync(path.join(mediaDir, "big.jpg")), big);
});

test("below 0.6 a keepsake is a low-confidence miss and is not confirmed; the catch-all is no match", async () => {
  replies.vision = visionSays({ match_id: "none", confidence: 0.9, object_label: "a white jug" });
  replies.confirm = confirms(0.9);
  sent.length = 0;
  replies.choose = chooses({ k_teapot: 0.5, k_medal: 0.1, other: 0.4 });
  assert.deepEqual(await look(), { matchId: null, confidence: 0.5, objectLabel: "a white jug", reason: "low_confidence" });

  replies.choose = chooses({ k_teapot: 0.1, k_medal: 0.1, other: 0.8 });
  assert.deepEqual(await look(), { matchId: null, confidence: 0.8, objectLabel: "a white jug", reason: undefined });
  assert.equal(decisionsOf("confirm").length, 0);
});

test("a miss is named by the vision model, shown the same keepsakes, and only its label is kept", async () => {
  replies.choose = chooses({ k_teapot: 0.1, k_medal: 0.1, other: 0.8 });
  // Even when the vision model thinks it is a keepsake, the Decisions API's "no" stands.
  replies.vision = visionSays({ match_id: "k_teapot", confidence: 0.9, object_label: "a blue teapot" });
  sent.length = 0;
  assert.deepEqual(await look(), { matchId: null, confidence: 0.8, objectLabel: "a blue teapot", reason: undefined });

  const vision = sent.find((s) => s.url !== DECISIONS);
  assert.match(vision.url, /:generateContent$/);
  const parts = vision.body.contents[0].parts;
  assert.equal(parts.filter((part) => part.inlineData).length, 4);
  assert.equal(parts.at(-1).inlineData.data, "frame".repeat(30));
});

test("a label that cannot be had leaves the miss unnamed rather than failing the look", async () => {
  replies.choose = chooses({ k_teapot: 0.1, k_medal: 0.1, other: 0.8 });
  replies.vision = { status: 400, body: { error: { message: "bad request" } } };
  assert.deepEqual(await look(), { matchId: null, confidence: 0.8, objectLabel: "", reason: undefined });
});

test("a blocked frame is no decision; an outage is an error for the look route to report", async () => {
  replies.choose = { status: 400, body: { error: { code: "image_safety", message: "blocked" } } };
  sent.length = 0;
  assert.equal((await look()).reason, "declined");
  // A frame the Decisions API would not look at is not sent on to be named.
  assert.equal(sent.length, 1);

  replies.choose = { status: 503, body: { error: { message: "overloaded" } } };
  await assert.rejects(look(), /Gemini Decisions 503/);
});

// ---- Getting keepsakes ready -----------------------------------------------------------------

const picture = (await sharp({ create: { width: 1400, height: 1000, channels: 3, background: "#aa5533" } }).png().toBuffer()).toString("base64");
const imageReply = { body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: picture } }] } }] } };

function storeOf(list) {
  const stored = list.map((k) => ({ ...k }));
  return {
    mediaDir,
    keepsakes: stored,
    keepsake: (id) => stored.find((k) => k.id === id),
    updateKeepsake: (id, patch) => Object.assign(stored.find((k) => k.id === id), patch),
  };
}

test("a keepsake is described once from its full-size photos, then tested against two look-alikes", async () => {
  const store = storeOf([keepsakes[1]]);
  replies.vision = visionSays({ features: "A bronze medal on a striped ribbon.", checks: ["The ribbon is striped.", "  "] });
  replies.image = imageReply;
  replies.choose = chooses({ k_medal: 0.1, other: 0.9 });
  const mistaken = [];
  sent.length = 0;
  await prepareKeepsakes(store, { onMightBeMistaken: (k) => mistaken.push(k.id) });

  const [medal] = store.keepsakes;
  assert.equal(medal.features, "A bronze medal on a striped ribbon.");
  assert.deepEqual(medal.checks, ["The ribbon is striped."]);
  assert.deepEqual({ ...medal.lookalikeTest, at: undefined }, { at: undefined, tried: 2, mistaken: 0 });
  assert.deepEqual(mistaken, []);

  // Described from the photo as stored, not a small copy.
  const described = sent.find((s) => /:generateContent$/.test(s.url) && !/image:/.test(s.url));
  assert.equal(described.body.contents[0].parts[1].inlineData.data, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));
  // Each look-alike is made from its photo, and looked at as the glasses would send it.
  const made = sent.filter((s) => /image:generateContent$/.test(s.url));
  assert.equal(made.length, 2);
  for (const { body } of decisionsOf("choose")) {
    const frame = await sharp(Buffer.from(body.input.at(-1).data, "base64")).metadata();
    assert.deepEqual([frame.format, frame.width], ["jpeg", 1024]);
  }

  // Ready: nothing more is sent.
  sent.length = 0;
  await prepareKeepsakes(store);
  assert.equal(sent.length, 0);
});

test("a look-alike taken for a memory asks the family for a close-up", async () => {
  const store = storeOf([{ ...keepsakes[0], lookalikeTest: undefined }]);
  replies.image = imageReply;
  replies.choose = chooses({ k_teapot: 0.97, other: 0.03 });
  // The first look-alike is confirmed as the teapot, the second is not.
  let confirmations = 0;
  replies.confirm = (body) => confirms(++confirmations === 1 ? 0.9 : 0.2)(body);
  const mistaken = [];
  await prepareKeepsakes(store, { onMightBeMistaken: (k) => mistaken.push(k.id) });

  assert.equal(store.keepsakes[0].lookalikeTest.mistaken, 1);
  assert.deepEqual(mistaken, ["k_teapot"]);
});

test("photos added while a keepsake is being prepared: nothing from the old ones is kept, and it goes again", async () => {
  const store = storeOf([{ id: "k_a", name: "A", referencePhotos: ["a.jpg"] }]);
  replies.image = imageReply;
  replies.choose = chooses({ k_a: 0.1, other: 0.9 });
  let described = 0;
  let again;
  replies.vision = () => {
    described++;
    if (described === 1) {
      // As the add-photos route does, mid-description.
      store.updateKeepsake("k_a", { referencePhotos: ["a.jpg", "b.jpg"], features: null, checks: null, lookalikeTest: null });
      again = prepareKeepsakes(store);
      return visionSays({ features: "From one photo.", checks: ["Old."] });
    }
    return visionSays({ features: "From both photos.", checks: ["New."] });
  };
  await prepareKeepsakes(store);
  await again;

  assert.equal(described, 2);
  assert.equal(store.keepsakes[0].features, "From both photos.");
  assert.equal(store.keepsakes[0].lookalikeTest.tried, 2);
});

test("what fails is left for next time, and does not stop the others", async () => {
  const store = storeOf([
    { id: "k_a", name: "A", referencePhotos: ["a.jpg"] },
    { id: "k_b", name: "B", referencePhotos: ["b.jpg"] },
  ]);
  let described = 0;
  replies.vision = () => (++described === 1 ? { status: 400, body: {} } : visionSays({ features: "B's features.", checks: ["B."] }));
  // No look-alike could be made: B is described but not yet tested.
  replies.image = { status: 503, body: {} };
  await prepareKeepsakes(store);

  assert.equal(store.keepsakes[0].features, undefined);
  assert.equal(store.keepsakes[1].features, "B's features.");
  assert.equal(store.keepsakes[1].lookalikeTest, undefined);
});
