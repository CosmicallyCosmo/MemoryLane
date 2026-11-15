import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { aiMode, chooseAnswer, prepareKeepsakes, recogniseKeepsake } from "./ai.js";
import { asksWhoItIsFrom, matchQuestionLocally } from "./matching.js";
import { registerFamily } from "./family.js";
import { createFilmMaker } from "./films.js";
import { cleanSession } from "./heart.js";
import { registerLanes } from "./lane.js";
import { registerPersonLanes } from "./person-lane.js";
import { buildSummary } from "./summary.js";
import { registerTranscripts } from "./transcript.js";

const MEDIA_TYPES = /^(image\/(jpeg|png|webp)|audio\/|video\/)/;
// Photos of the object are sent to the recogniser on every look: one that is not a picture
// would have every look refused.
const PICTURE = /^image\/(jpeg|png|webp)$/;
const NOT_A_PICTURE = "Photos of the object must be pictures: JPEG, PNG or WebP.";
// Events the phone is allowed to report. Looks and questions are logged by the server itself.
const CLIENT_EVENTS = new Set([
  "memory_replayed",
  "clip_watched",
  "browse_opened",
  "privacy_pause",
  "privacy_resume",
  "glasses_removed",
  "connection_lost",
  "low_battery",
  // Heart rate while a memory was open. Kept only when the family switched it on.
  "heart_response",
]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCKOUT_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const SESSION_COOKIE = "ml_session";
const TOO_MANY = "Too many wrong codes. Wait ten minutes and try again.";

/** Compares without leaking, through timing, how much of a guess was right. */
function sameSecret(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

/**
 * @param {{store: object, familyDist?: string, isLoopback?: (req: object) => boolean}} options
 *   `isLoopback` exists so tests can stand in for a request from another machine.
 */
export function createApp({
  store,
  familyDist,
  // The socket's own address, never a forwarded header, which any client can set.
  isLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress ?? ""),
}) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // ---- Who may talk to this server -----------------------------------------------------
  //
  // This machine itself is trusted: the laptop's browser, and a phone over `adb reverse`,
  // both arrive on loopback. Everything else must present the household code, as a header
  // (the phone), a query parameter (media players that cannot set headers) or the session
  // cookie the family app gets after the code is typed in once.

  // The cookie is derived from the code, so issuing a new code ends every session.
  const sessionValue = () =>
    crypto.createHmac("sha256", store.accessCode).update("memorylane-session").digest("hex");
  const sessionCookie = () =>
    `${SESSION_COOKIE}=${sessionValue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;

  const failures = new Map();
  const lockedOut = (address) => {
    const entry = failures.get(address);
    if (!entry) return false;
    if (Date.now() - entry.since > LOCKOUT_WINDOW_MS) {
      failures.delete(address);
      return false;
    }
    return entry.count >= LOCKOUT_FAILURES;
  };
  const recordFailure = (address) => {
    const entry = failures.get(address);
    if (!entry || Date.now() - entry.since > LOCKOUT_WINDOW_MS) {
      failures.set(address, { count: 1, since: Date.now() });
    } else {
      entry.count++;
    }
  };

  app.use((req, res, next) => {
    if (isLoopback(req)) {
      req.trusted = true;
      return next();
    }
    const address = req.socket.remoteAddress ?? "unknown";
    if (lockedOut(address)) return res.status(429).json({ error: TOO_MANY });

    const offered =
      req.get("x-memorylane-code") || (typeof req.query.code === "string" ? req.query.code : "");
    if (offered) {
      if (sameSecret(offered.trim().toUpperCase(), store.accessCode)) req.trusted = true;
      else recordFailure(address);
    } else {
      const cookie = readCookie(req, SESSION_COOKIE);
      if (cookie && sameSecret(cookie, sessionValue())) req.trusted = true;
    }
    next();
  });

  app.post("/api/session", (req, res) => {
    const offered = String(req.body?.code ?? "").trim().toUpperCase();
    if (!req.trusted && !(offered && sameSecret(offered, store.accessCode))) {
      if (offered) recordFailure(req.socket.remoteAddress ?? "unknown");
      return res.status(401).json({ error: "code_required" });
    }
    res.setHeader("Set-Cookie", sessionCookie());
    res.json({ ok: true });
  });

  const requireCode = (req, res, next) => {
    if (req.trusted) return next();
    res.status(401).json({ error: "code_required" });
  };
  app.use("/media", requireCode);
  app.use("/api", (req, res, next) => {
    // Health says only that the server is up, so a phone can tell "wrong code" from "offline".
    if (req.path === "/health") return next();
    requireCode(req, res, next);
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: store.mediaDir,
      filename: (_req, file, done) =>
        done(null, `${store.newId("m")}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 80 * 1024 * 1024, files: 16 },
    fileFilter: (_req, file, done) => done(null, MEDIA_TYPES.test(file.mimetype)),
  });

  const mediaUrl = (file) => (!file ? null : file.startsWith("http") ? file : `/media/${file}`);
  // Glasses copies made by Cloudinary when it is set up; see films.js.
  const films = createFilmMaker({ store });
  app.locals.films = films;
  const lanes = registerLanes(app, { store, upload, mediaUrl, films });
  registerTranscripts(app, { store });
  registerPersonLanes(app, { store, upload, mediaUrl, requireCode, grantSession: (res) => res.setHeader("Set-Cookie", sessionCookie()) });
  const publicKeepsake = (k) => ({
    id: k.id,
    name: k.name,
    description: k.description,
    from: k.from,
    introLine: k.introLine,
    story: k.story,
    referencePhotos: k.referencePhotos.map(mediaUrl),
    memoryPhotos: k.memoryPhotos.map(mediaUrl),
    voiceNote: mediaUrl(k.voiceNote),
    clip: mediaUrl(k.clip),
    // A picture for its tile, chosen and cropped by Cloudinary; null without it.
    poster: k.poster ?? null,
    // Its photos and video as a slow film, with the voice message as its sound; null if none.
    lane: lanes.publicLane(k),
    answers: k.answers.map((a) => ({ ...a, audio: mediaUrl(a.audio) })),
    addedBy: k.addedBy ?? null,
    // Relatives who appear in this memory, so "who is that?" has an answer.
    people: k.people ?? [],
    createdAt: k.createdAt,
    // Its self-test took a look-alike for a memory: a close-up of what only this one has helps.
    mightBeMistaken: Boolean(k.lookalikeTest?.mistaken),
  });

  app.use("/media", express.static(store.mediaDir, { maxAge: "1h" }));

  app.get("/api/health", (req, res) => {
    // To anyone without the code: up or down, and nothing about the household.
    if (!req.trusted) return res.json({ ok: true, recogniser: aiMode(), codeRequired: true });
    res.json({
      ok: true,
      recogniser: aiMode(),
      keepsakes: store.keepsakes.length,
      packVersion: store.packVersion(),
    });
  });

  // ---- Pairing a phone -----------------------------------------------------------------

  const pairing = (req) => {
    const port = req.socket.localPort;
    const urls = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal)
      .map((n) => `http://${n.address}:${port}`);
    const code = store.accessCode;
    return {
      code,
      urls,
      // Opened by the phone's own camera app when it scans the QR code in the family app.
      link: urls.length
        ? `memorylane://pair?server=${encodeURIComponent(urls[0])}&code=${encodeURIComponent(code)}`
        : null,
    };
  };

  app.get("/api/pairing", (req, res) => res.json(pairing(req)));

  app.post("/api/pairing/rotate", (req, res) => {
    store.rotateAccessCode();
    failures.clear();
    // Whoever asked stays signed in. Every other session and paired phone needs the new code.
    res.setHeader("Set-Cookie", sessionCookie());
    res.json(pairing(req));
  });

  // ---- Profile and consent -------------------------------------------------------------

  app.get("/api/profile", (_req, res) => res.json(store.profile));

  app.put("/api/profile", (req, res) => {
    const { wearerName, carerName, consent } = req.body ?? {};
    const patch = {};
    if (typeof wearerName === "string") patch.wearerName = wearerName.trim().slice(0, 60);
    if (typeof carerName === "string") patch.carerName = carerName.trim().slice(0, 60);
    if (consent && typeof consent === "object") {
      patch.consent = {};
      for (const key of ["wearerAgreed", "logUnknownObjects", "careSignals", "heartRate"]) {
        if (typeof consent[key] === "boolean") patch.consent[key] = consent[key];
      }
      if (typeof consent.agreedBy === "string") patch.consent.agreedBy = consent.agreedBy.trim().slice(0, 80);
      if (consent.wearerAgreed === true && !store.profile.consent.wearerAgreed) {
        patch.consent.agreedAt = new Date().toISOString();
      }
      if (consent.wearerAgreed === false) patch.consent.agreedAt = null;
    }
    // Who made the change, so the consent page can show a history. Only a known member counts.
    const by = store.members.some((m) => m.id === req.body?.changedBy) ? req.body.changedBy : null;
    const before = store.profile.consent;
    const changes = Object.entries(patch.consent ?? {})
      .filter(([key, value]) => typeof value === "boolean" && value !== before[key])
      .map(([what, on]) => ({ what, on, by, ...(what === "wearerAgreed" && on ? { agreedBy: patch.consent.agreedBy ?? before.agreedBy } : {}) }));
    const saved = store.setProfile(patch);
    store.logConsent(changes);
    // Switching heart rate off takes what was kept with it.
    if (before.heartRate && !saved.consent.heartRate) {
      store.removeEventsOfType("heart_response");
      family.clearHeartNotices();
    }
    res.json(saved);
  });

  const family = registerFamily(app, { store, publicKeepsake, upload, mediaUrl, films });
  // Features, checks and the look-alike self-test, in the background; at start for memories
  // without them (added before, or while the model was down).
  const prepare = () => prepareKeepsakes(store, { onMightBeMistaken: (k) => family.mightBeMistaken(k) });
  prepare();
  const memberIds = (value) =>
    String(value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => store.members.some((m) => m.id === id));

  // ---- Keepsakes -----------------------------------------------------------------------

  app.get("/api/keepsakes", (_req, res) => res.json(store.keepsakes.map(publicKeepsake)));

  const keepsakeFiles = upload.fields([
    { name: "referencePhotos", maxCount: 4 },
    { name: "memoryPhotos", maxCount: 6 },
    { name: "voiceNote", maxCount: 1 },
    { name: "clip", maxCount: 1 },
  ]);

  app.post("/api/keepsakes", keepsakeFiles, async (req, res) => {
    const files = req.files ?? {};
    const names = (field) => (files[field] ?? []).map((f) => f.filename);
    const discard = () =>
      Object.values(files)
        .flat()
        .forEach((f) => fs.rmSync(f.path, { force: true }));

    const name = String(req.body.name ?? "").trim();
    if (!name) {
      discard();
      return res.status(400).json({ error: "Please give the memory a name." });
    }
    if (names("referencePhotos").length === 0) {
      discard();
      return res.status(400).json({ error: "Please add at least one photo of the object." });
    }
    if ((files.referencePhotos ?? []).some((f) => !PICTURE.test(f.mimetype))) {
      discard();
      return res.status(400).json({ error: NOT_A_PICTURE });
    }
    if (names("voiceNote").length === 0) {
      discard();
      return res.status(400).json({ error: "Please record or add a voice message." });
    }
    // People appear and speak in this material. Nothing is stored until the person adding it
    // confirms that everyone pictured or recorded has agreed.
    if (req.body.consentConfirmed !== "true") {
      discard();
      return res.status(400).json({
        error: "Please confirm that everyone pictured or recorded has agreed to be included.",
      });
    }

    const clip = names("clip")[0] ?? null;
    const from = String(req.body.from ?? "").trim().slice(0, 60);
    const keepsake = store.addKeepsake({
      id: store.newId("k"),
      name: name.slice(0, 80),
      description: String(req.body.description ?? "").trim().slice(0, 400),
      from,
      introLine:
        String(req.body.introLine ?? "").trim().slice(0, 200) ||
        (from ? `Here's a message ${from} recorded for you.` : "Here's a memory about this."),
      story: String(req.body.story ?? "").trim().slice(0, 1200),
      referencePhotos: names("referencePhotos"),
      memoryPhotos: names("memoryPhotos"),
      voiceNote: names("voiceNote")[0],
      clip,
      lane: null,
      answers: [],
      addedBy: String(req.body.addedBy ?? "").slice(0, 40) || null,
      people: memberIds(req.body.people),
      createdAt: new Date().toISOString(),
    });
    // Photos or a video become its lane. Planned before answering, so the family lands on
    // a film ready to watch; without a model, or if it fails, the plan is a simple one.
    await lanes.attach(keepsake);
    family.keepsakeAdded(keepsake);
    prepare();
    res.status(201).json(publicKeepsake(keepsake));
  });

  // More photos of the object, such as a close-up of a mark only this one has, when the
  // self-test found it could be taken for a look-alike. Its features, checks and self-test are
  // then made again from all of its photos.
  const MAX_REFERENCE_PHOTOS = 8;
  app.post("/api/keepsakes/:id/photos", upload.array("referencePhotos", 4), (req, res) => {
    const files = req.files ?? [];
    const discard = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    const keepsake = store.keepsake(req.params.id);
    if (!keepsake) {
      discard();
      return res.status(404).json({ error: "Not found." });
    }
    if (!files.length) return res.status(400).json({ error: "Please add a photo of the object." });
    if (files.some((f) => !PICTURE.test(f.mimetype))) {
      discard();
      return res.status(400).json({ error: NOT_A_PICTURE });
    }
    if (keepsake.referencePhotos.length + files.length > MAX_REFERENCE_PHOTOS) {
      discard();
      return res.status(400).json({ error: `A memory can have up to ${MAX_REFERENCE_PHOTOS} photos of the object.` });
    }
    const updated = store.updateKeepsake(keepsake.id, {
      referencePhotos: [...keepsake.referencePhotos, ...files.map((f) => f.filename)],
      features: null,
      checks: null,
      lookalikeTest: null,
    });
    prepare();
    res.json(publicKeepsake(updated));
  });

  app.delete("/api/keepsakes/:id", (req, res) => {
    // What was uploaded to Cloudinary for it goes too.
    films.forget(store.keepsake(req.params.id));
    if (!store.deleteKeepsake(req.params.id)) return res.status(404).json({ error: "Not found." });
    res.status(204).end();
  });

  app.post("/api/keepsakes/:id/answers", upload.single("audio"), (req, res) => {
    const question = String(req.body.question ?? "").trim();
    const text = String(req.body.text ?? "").trim();
    const discard = () => req.file && fs.rmSync(req.file.path, { force: true });
    if (!question || (!text && !req.file)) {
      discard();
      return res.status(400).json({ error: "Please record an answer or type one." });
    }
    const answer = store.addAnswer(req.params.id, {
      id: store.newId("a"),
      question: question.slice(0, 200),
      text: text.slice(0, 600),
      speaker: String(req.body.speaker ?? "").trim().slice(0, 60),
      audio: req.file?.filename ?? null,
      addedBy: String(req.body.addedBy ?? "").slice(0, 40) || null,
      createdAt: new Date().toISOString(),
    });
    if (!answer) {
      discard();
      return res.status(404).json({ error: "Not found." });
    }
    family.answerAdded(store.keepsake(req.params.id), answer);
    res.status(201).json({ ...answer, audio: mediaUrl(answer.audio) });
  });

  app.delete("/api/keepsakes/:id/answers/:answerId", (req, res) => {
    if (!store.deleteAnswer(req.params.id, req.params.answerId)) {
      return res.status(404).json({ error: "Not found." });
    }
    res.status(204).end();
  });

  // Everything the phone needs to keep working with no connection.
  app.get("/api/pack", (_req, res) => {
    res.json({
      version: store.packVersion(),
      profile: store.profile,
      keepsakes: store.keepsakes.map(publicKeepsake),
      people: store.members.map(family.publicPerson),
      // Answers to everyday questions, so they still work with no connection.
      answers: store.bank.map((a) => ({ ...a, audio: mediaUrl(a.audio) })),
    });
  });

  // ---- The glasses loop ----------------------------------------------------------------

  app.post("/api/recognise", async (req, res) => {
    const frame = req.body?.image;
    if (typeof frame !== "string" || frame.length < 100) {
      return res.status(400).json({ error: "Send the frame as base64 JPEG in `image`." });
    }
    if (!store.profile.consent.wearerAgreed) {
      return res.status(403).json({ error: "consent_required" });
    }
    const started = Date.now();
    let result;
    try {
      result = await recogniseKeepsake({
        frameBase64: frame,
        keepsakes: store.keepsakes,
        mediaDir: store.mediaDir,
        hint: req.body.hint,
      });
    } catch (error) {
      // Timeouts, rate limits and outages all look the same to the wearer: we could not look.
      console.warn("recognise failed:", error?.message ?? error);
      return res.status(503).json({ error: "recogniser_unavailable", latencyMs: Date.now() - started });
    }
    const latencyMs = Date.now() - started;
    // The frame is dropped here. Only what was decided is kept, and an unknown object's label
    // only if the family opted in.
    store.addEvent({
      type: "look",
      matchId: result.matchId,
      objectLabel:
        !result.matchId && store.profile.consent.logUnknownObjects ? result.objectLabel : undefined,
      latencyMs,
    });
    family.looked(result);
    const keepsake = result.matchId ? store.keepsake(result.matchId) : null;
    // People are never recognised by their face. A memory can say who is in it; that is how a
    // framed photograph answers "who is that?". Asked just that, it is the person whose memory it
    // is, if they are in it, as on the glasses.
    const inIt = keepsake?.people ?? [];
    const personId = inIt.includes(keepsake?.addedBy) ? keepsake.addedBy : inIt[0];
    const person = store.members.find((m) => m.id === personId) ?? null;
    res.json({
      matchId: result.matchId,
      confidence: result.confidence,
      objectLabel: result.objectLabel,
      reason: result.reason,
      latencyMs,
      keepsake: keepsake ? publicKeepsake(keepsake) : null,
      person: person ? family.publicPerson(person) : null,
    });
  });

  /** Who a memory is from, as the family put it, and the relative who added it if there is one. */
  const whoItIsFrom = (keepsake) => {
    const person = store.members.find((m) => m.id === keepsake.addedBy) ?? null;
    const name = keepsake.from || person?.name || "";
    return name ? { name, person } : null;
  };

  app.post("/api/ask", async (req, res) => {
    const question = String(req.body?.question ?? "").trim().slice(0, 300);
    // A question can be about the memory that is open, or about nothing in particular
    // ("Where is Margaret?"). Answers for the open memory are tried first, then everyday ones.
    const keepsake = store.keepsake(req.body?.keepsakeId) ?? null;
    if (!question) return res.status(400).json({ error: "Need a question." });
    // How sure the glasses' speech recogniser was of the words, 0 to 1, when it says.
    const heard = Number(req.body?.confidence);
    const confidence = Number.isFinite(heard) && heard >= 0 && heard <= 1 ? Math.round(heard * 100) / 100 : undefined;
    const candidates = [...(keepsake?.answers ?? []), ...store.bank];

    let answer = matchQuestionLocally(question, candidates)?.answer ?? null;
    if (!answer) {
      try {
        const id = await chooseAnswer({
          question,
          keepsake: { name: keepsake?.name ?? "everyday questions", answers: candidates },
        });
        answer = candidates.find((a) => a.id === id) ?? null;
      } catch (error) {
        console.warn("ask failed:", error?.message ?? error);
      }
    }

    // Who a memory is from is something the family already said, so "Where did this come
    // from?" is answered from that when nobody has recorded an answer to it. It is said as
    // the family wrote it, and the person who added it then says hello in their own words.
    const giver = !answer && keepsake && asksWhoItIsFrom(question) ? whoItIsFrom(keepsake) : null;

    if (store.profile.consent.careSignals) {
      store.addEvent({ type: "question", keepsakeId: keepsake?.id ?? null, question, answerId: answer?.id ?? null, confidence });
      // Still noted as unanswered, so the family can record the story behind it.
      family.questionAsked(keepsake, question, answer);
      const sure = confidence === undefined ? "" : ` (heard at ${Math.round(confidence * 100)}%)`;
      const outcome = answer ? `answer ${answer.id}` : giver ? `from ${giver.name}` : "no answer";
      console.log(`asked “${question}”${sure}${keepsake ? ` about ${keepsake.name}` : ""}: ${outcome}`);
    }

    if (giver) {
      const say = `This is from ${giver.name}.`;
      return res.json({ kind: "written", text: say, speaker: "", audio: null, say, personId: giver.person?.id ?? null });
    }

    if (!answer) {
      const carer = store.profile.carerName;
      // Only promise to pass the question on when it really is noted and sent to the family.
      const noted = store.profile.consent.careSignals;
      return res.json({
        kind: "none",
        // The only words here are fixed ones. Nothing is invented on the family's behalf.
        say: !noted
          ? "I don't have an answer for that yet. Your family can help with that one."
          : carer
            ? `I don't have an answer for that yet. I'll let ${carer} know you asked.`
            : "I don't have an answer for that yet. I've made a note, so the family can answer it.",
      });
    }
    res.json({
      // "recorded" plays the person's own voice. "written" is read aloud by a neutral voice
      // and says who wrote it. A family member's voice is never synthesised.
      kind: answer.audio ? "recorded" : "written",
      answerId: answer.id,
      question: answer.question,
      text: answer.text,
      speaker: answer.speaker,
      audio: mediaUrl(answer.audio),
      say: answer.audio ? null : answer.speaker ? `${answer.speaker} wrote: ${answer.text}` : answer.text,
    });
  });

  // ---- Care signals --------------------------------------------------------------------

  app.post("/api/events", (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : [];
    let stored = 0;
    for (const event of events) {
      if (!CLIENT_EVENTS.has(event?.type)) continue;
      let heart;
      if (event.type === "heart_response") {
        // Dropped unless the family switched heart rate on, it belongs to a memory, and it reads true.
        const { consent } = store.profile;
        heart = consent.wearerAgreed && consent.heartRate && store.keepsake(event.keepsakeId) ? cleanSession(event.heart) : null;
        if (!heart) continue;
      }
      const kept = store.addEvent({
        type: event.type,
        keepsakeId: typeof event.keepsakeId === "string" ? event.keepsakeId : undefined,
        at: typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)) ? event.at : undefined,
        heart,
      });
      family.clientEvent(event.type, kept);
      stored++;
    }
    res.json({ stored });
  });

  app.get("/api/summary", (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
    res.json(buildSummary({ events: store.events, keepsakes: store.keepsakes, days }));
  });

  app.delete("/api/events", (_req, res) => {
    store.clearEvents();
    family.clearWearerNotices();
    res.status(204).end();
  });

  // ---- Family web app ------------------------------------------------------------------

  if (familyDist && fs.existsSync(familyDist)) {
    app.use(express.static(familyDist));
    app.get(/^\/(?!api|media|lane\/).*/,(_req, res) => res.sendFile(path.join(familyDist, "index.html")));
  }

  app.use((error, _req, res, _next) => {
    const status = error?.code === "LIMIT_FILE_SIZE" ? 413 : (error?.status ?? 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 413 ? "That file is too large." : "Something went wrong." });
  });

  return app;
}
