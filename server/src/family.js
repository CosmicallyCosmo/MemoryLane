// The family side: who contributes, what they are told, and the fuller picture for the
// dashboard. Everything about the wearer here is derived from the same event log as the
// summary, and nothing about the wearer is recorded unless the family opted in to care signals.
import path from "node:path";
import { cloudinaryEnabled, uploadDisplayClip } from "./cloudinary.js";
import { describeHeart, summarise, typical } from "./heart.js";
import { personLane, removePersonLane } from "./person-lane.js";
import { matchQuestionLocally, questionKey } from "./matching.js";
import { buildSummary } from "./summary.js";

const DAY = 24 * 60 * 60 * 1000;
const RELATIONSHIPS = 60;

const text = (value, max) => String(value ?? "").trim().slice(0, max);

function median(values, fraction = 0.5) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** What happened, in words a relative would use. Returns null for events not worth listing. */
function describe(event, nameOf, wearer) {
  const who = wearer || "The wearer";
  switch (event.type) {
    case "look":
      return event.matchId
        ? { kind: "memory", text: `${who} picked up ${nameOf(event.matchId)} and heard its memory.` }
        : {
            kind: "unknown",
            text: event.objectLabel
              ? `${who} looked at ${event.objectLabel}, which doesn't hold a memory yet.`
              : `${who} looked at something that doesn't hold a memory yet.`,
          };
    case "question":
      return event.answerId
        ? { kind: "answered", text: `${who} asked “${event.question}”${event.keepsakeId ? ` about ${nameOf(event.keepsakeId)}` : ""} and heard the family's answer.` }
        : { kind: "unanswered", text: `${who} asked “${event.question}”${event.keepsakeId ? ` about ${nameOf(event.keepsakeId)}` : ""}. Nobody has answered that one yet.` };
    case "memory_replayed":
      return { kind: "memory", text: `${who} listened to ${nameOf(event.keepsakeId)} again.` };
    case "clip_watched":
      return { kind: "memory", text: `${who} watched the video in ${nameOf(event.keepsakeId)}.` };
    case "heart_response":
      return event.heart ? { kind: "heart", text: describeHeart(summarise(event.heart), wearer) } : null;
    case "browse_opened":
      return { kind: "info", text: `${who} looked through their memories.` };
    case "privacy_pause":
      return { kind: "info", text: "The glasses were paused for a little privacy." };
    case "privacy_resume":
      return { kind: "info", text: "The glasses started again after a privacy pause." };
    case "glasses_removed":
      return { kind: "info", text: "The glasses were taken off." };
    case "low_battery":
      return { kind: "warning", text: "The glasses were running low on battery." };
    case "connection_lost":
      return { kind: "warning", text: "The glasses lost touch with their phone for a while." };
    default:
      return null;
  }
}

export function registerFamily(app, { store, publicKeepsake, upload, mediaUrl, films = null }) {
  const nameOf = (id) => {
    const name = store.keepsakes.find((k) => k.id === id)?.name;
    return name ? `the ${name.replace(/^the /i, "")}` : "a removed memory";
  };
  /** " about the teapot" for a question tied to a memory, nothing for an everyday one. */
  const about = (keepsake) => (keepsake ? ` about ${nameOf(keepsake.id)}` : "");
  const memberName = (id) => store.members.find((m) => m.id === id)?.name ?? "";
  const wearer = () => store.profile.wearerName || "The wearer";

  // ---- Notifications -------------------------------------------------------------------

  /**
   * Adds a notice unless the same thing was already said recently. `key` identifies "the same
   * thing"; `quietFor` is how long to stay silent about it.
   */
  function notify({ type, title, body, key, quietFor = DAY, keepsakeId, question, byMember, forMember }) {
    const now = Date.now();
    if (key && store.notifications.some((n) => n.key === key && now - Date.parse(n.at) < quietFor)) {
      return null;
    }
    const notice = {
      id: store.newId("n"),
      type,
      title,
      body,
      key: key ?? null,
      at: new Date(now).toISOString(),
      keepsakeId: keepsakeId ?? null,
      question: question ?? null,
      byMember: byMember ?? null,
      forMember: forMember ?? null,
      readBy: [],
    };
    store.notifications.push(notice);
    if (store.notifications.length > 500) store.notifications = store.notifications.slice(-500);
    store.save();
    return notice;
  }

  const visibleTo = (memberId) => (n) =>
    (!n.forMember || n.forMember === memberId) && !(n.byMember && n.byMember === memberId);

  const publicNotice = (memberId) => (n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    at: n.at,
    keepsakeId: n.keepsakeId,
    question: n.question,
    read: n.readBy.includes(memberId || "everyone"),
  });

  app.get("/api/notifications", (req, res) => {
    const memberId = text(req.query.member, 40);
    const list = store.notifications.filter(visibleTo(memberId)).slice(-100).reverse().map(publicNotice(memberId));
    res.json({ unread: list.filter((n) => !n.read).length, notifications: list });
  });

  app.post("/api/notifications/read", (req, res) => {
    const reader = text(req.body?.member, 40) || "everyone";
    const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids) : null;
    for (const n of store.notifications) {
      if ((req.body?.all || ids?.has(n.id)) && !n.readBy.includes(reader)) n.readBy.push(reader);
    }
    store.save();
    res.status(204).end();
  });

  // One relative asking another to record an answer.
  app.post("/api/notifications/request", (req, res) => {
    const forMember = text(req.body?.forMember, 40);
    const keepsake = store.keepsake(req.body?.keepsakeId) ?? null;
    const question = text(req.body?.question, 200);
    if (!store.members.some((m) => m.id === forMember) || !question) {
      return res.status(400).json({ error: "Choose who you'd like to ask, and which question." });
    }
    const from = memberName(text(req.body?.fromMember, 40));
    const notice = notify({
      type: "request",
      title: `${from || "Someone"} would love you to answer a question`,
      body: `“${question}”${about(keepsake)}. It would mean a lot to ${store.profile.wearerName || "them"} to hear it from you.`,
      key: `request|${forMember}|${keepsake?.id ?? ""}|${questionKey(question)}`,
      quietFor: 60 * 60 * 1000,
      keepsakeId: keepsake?.id ?? null,
      question,
      byMember: text(req.body?.fromMember, 40) || null,
      forMember,
    });
    res.status(notice ? 201 : 200).json({ sent: Boolean(notice) });
  });

  // ---- Members -------------------------------------------------------------------------

  function memberStats(member) {
    let keepsakesAdded = 0;
    let answersRecorded = 0;
    let voiceRecordings = 0;
    let last = null;
    const touch = (at) => {
      if (at && (!last || at > last)) last = at;
    };
    for (const keepsake of store.keepsakes) {
      if (keepsake.addedBy === member.id) {
        keepsakesAdded++;
        if (keepsake.voiceNote) voiceRecordings++;
        touch(keepsake.createdAt);
      }
      for (const answer of keepsake.answers) {
        if (answer.addedBy !== member.id) continue;
        answersRecorded++;
        if (answer.audio) voiceRecordings++;
        touch(answer.createdAt);
      }
    }
    // How often the wearer has heard something this person contributed.
    const theirKeepsakes = new Set(store.keepsakes.filter((k) => k.addedBy === member.id).map((k) => k.id));
    const theirAnswers = new Set(
      store.keepsakes.flatMap((k) => k.answers.filter((a) => a.addedBy === member.id).map((a) => a.id)),
    );
    const timesHeard = store.events.filter(
      (e) =>
        (e.type === "look" && theirKeepsakes.has(e.matchId)) ||
        (e.type === "question" && theirAnswers.has(e.answerId)),
    ).length;
    return { keepsakesAdded, answersRecorded, voiceRecordings, timesHeard, lastContributionAt: last };
  }

  /** What the glasses need to introduce someone: no statistics, no role. */
  const publicPerson = (m) => ({
    id: m.id,
    name: m.name,
    relationship: m.relationship,
    photo: mediaUrl(m.photo ?? null),
    introText: m.introText ?? "",
    introAudio: mediaUrl(m.introAudio ?? null),
    // A short video of them to go with the hello, and the small copy of both that the glasses
    // play (a silent video for the display and its sound apart, as for a memory lane).
    introVideo: mediaUrl(m.introVideo ?? null),
    introLens: m.introLens ? { video: mediaUrl(m.introLens.video), audio: mediaUrl(m.introLens.audio) } : null,
    // With Cloudinary set up the server makes that copy itself, and a still for their picture.
    introLensByServer: Boolean(films?.enabled()),
    introLensMaking: films?.helloState(m).making ?? false,
    introPoster: m.introPoster ?? null,
    // Their memory lane, if they have added one: clips from their life to walk through.
    lane: personLane(m, mediaUrl),
  });

  const publicMember = (m) => ({
    ...publicPerson(m),
    role: m.role,
    createdAt: m.createdAt,
    ...memberStats(m),
  });

  // A profile: a photo of the person, and their own "this is who I am" recording, which is
  // what the wearer hears when they ask "who is that?".
  app.post(
    "/api/members/:id/profile",
    upload.fields([
      { name: "photo", maxCount: 1 },
      { name: "introAudio", maxCount: 1 },
      { name: "introVideo", maxCount: 1 },
      { name: "lensVideo", maxCount: 1 },
      { name: "lensAudio", maxCount: 1 },
    ]),
    async (req, res) => {
      const files = req.files ?? {};
      const member = store.members.find((m) => m.id === req.params.id);
      if (!member) {
        Object.values(files).flat().forEach((f) => store.removeMedia(f.filename));
        return res.status(404).json({ error: "Not found." });
      }
      if (files.photo?.[0]) {
        store.removeMedia(member.photo);
        member.photo = files.photo[0].filename;
      }
      if (files.introAudio?.[0]) {
        store.removeMedia(member.introAudio);
        member.introAudio = files.introAudio[0].filename;
      }
      if (req.body.removeIntroAudio === "true") {
        store.removeMedia(member.introAudio);
        member.introAudio = null;
      }
      if (files.introVideo?.[0]?.mimetype.startsWith("video/")) {
        films?.forget(member, [member.introVideo]);
        store.removeMedia(member.introVideo);
        member.introVideo = files.introVideo[0].filename;
      } else if (files.introVideo?.[0]) {
        store.removeMedia(files.introVideo[0].filename);
      }
      if (req.body.removeIntroVideo === "true") {
        films?.forget(member, [member.introVideo]);
        store.removeMedia(member.introVideo);
        member.introVideo = null;
      }
      // The glasses copy belongs to one recording and one video. When either changes it is out
      // of date, and the glasses go back to the recording on its own until a new copy is made.
      const lens = { video: files.lensVideo?.[0], audio: files.lensAudio?.[0] };
      const changed = files.introAudio?.[0] || files.introVideo?.[0] || req.body.removeIntroAudio === "true" || req.body.removeIntroVideo === "true";
      if (changed && member.introLens) {
        store.removeMedia(member.introLens.video);
        store.removeMedia(member.introLens.audio);
        member.introLens = null;
        member.introPoster = null;
      }
      if (lens.video && lens.audio && !changed && member.introVideo && path.extname(lens.video.filename) === ".mp4") {
        if (member.introLens) {
          store.removeMedia(member.introLens.video);
          store.removeMedia(member.introLens.audio);
        }
        // As for a memory lane: served from Cloudinary when it is set up, otherwise from here.
        let shown = lens.video.filename;
        if (cloudinaryEnabled()) {
          try {
            shown = await uploadDisplayClip(lens.video.path);
            store.removeMedia(lens.video.filename);
          } catch (error) {
            console.warn(String(error));
          }
        }
        member.introLens = { video: shown, audio: lens.audio.filename };
      } else {
        [lens.video, lens.audio].forEach((f) => f && store.removeMedia(f.filename));
      }
      if (typeof req.body.introText === "string") member.introText = text(req.body.introText, 300);
      store.save();
      // With Cloudinary, the glasses copy is made here from the video and the recording.
      if (changed) films?.hello(member);
      res.json(publicMember(member));
    },
  );

  // Asks for a hello's glasses copy to be made again by Cloudinary.
  app.post("/api/members/:id/hello/make", (req, res) => {
    const member = store.members.find((m) => m.id === req.params.id);
    if (!member) return res.status(404).json({ error: "Not found." });
    if (!films?.hello(member)) return res.status(409).json({ error: "A hello needs a video and a recording, and Cloudinary set up on this server." });
    res.status(202).json(publicMember(member));
  });

  app.get("/api/members", (_req, res) => res.json(store.members.map(publicMember)));

  app.post("/api/members", (req, res) => {
    const name = text(req.body?.name, 60);
    if (!name) return res.status(400).json({ error: "Please add their name." });
    if (store.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "Someone with that name is already in the family. Try adding a surname or a nickname." });
    }
    const member = {
      id: store.newId("p"),
      name,
      relationship: text(req.body?.relationship, RELATIONSHIPS),
      // The first person to arrive organises the household; everyone after contributes.
      role: store.members.length === 0 ? "organiser" : "contributor",
      createdAt: new Date().toISOString(),
    };
    store.members.push(member);
    store.save();
    notify({
      type: "member_joined",
      title: `${member.name} joined the family`,
      body: `${member.relationship ? `${member.relationship}. ` : ""}They can now share memories and answer questions for ${store.profile.wearerName || "the family"}.`,
      byMember: member.id,
    });
    res.status(201).json(publicMember(member));
  });

  app.patch("/api/members/:id", (req, res) => {
    const member = store.members.find((m) => m.id === req.params.id);
    if (!member) return res.status(404).json({ error: "Not found." });
    if (typeof req.body?.name === "string" && text(req.body.name, 60)) member.name = text(req.body.name, 60);
    if (typeof req.body?.relationship === "string") member.relationship = text(req.body.relationship, RELATIONSHIPS);
    if (req.body?.role === "organiser" || req.body?.role === "contributor") {
      const organisers = store.members.filter((m) => m.role === "organiser" && m.id !== member.id).length;
      if (req.body.role === "contributor" && member.role === "organiser" && organisers === 0) {
        return res.status(400).json({ error: "Someone needs to look after the family's settings. Ask another person to take this on first." });
      }
      member.role = req.body.role;
    }
    store.save();
    res.json(publicMember(member));
  });

  app.delete("/api/members/:id", (req, res) => {
    const member = store.members.find((m) => m.id === req.params.id);
    if (!member) return res.status(404).json({ error: "Not found." });
    if (member.role === "organiser" && store.members.filter((m) => m.role === "organiser").length === 1 && store.members.length > 1) {
      return res.status(400).json({ error: "This person looks after the family's settings. Ask someone else to take this on before removing them." });
    }
    // What they recorded stays: it was made for the wearer, not for the account. Their own
    // photo and introduction go with them.
    store.removeMedia(member.photo);
    store.removeMedia(member.introAudio);
    store.removeMedia(member.introVideo);
    store.removeMedia(member.introLens?.video);
    store.removeMedia(member.introLens?.audio);
    removePersonLane(store, member);
    store.members = store.members.filter((m) => m.id !== member.id);
    store.save();
    res.status(204).end();
  });

  // ---- Consent, in one place ------------------------------------------------------------
  //
  // Everything that has been agreed, by whom and when, and what each agreement switches on.

  app.get("/api/consent", (_req, res) => {
    const { consent } = store.profile;
    res.json({
      wearerName: store.profile.wearerName,
      wearer: { agreed: consent.wearerAgreed, agreedBy: consent.agreedBy, agreedAt: consent.agreedAt },
      choices: {
        heartRate: consent.heartRate,
        careSignals: consent.careSignals,
        logUnknownObjects: consent.logUnknownObjects,
      },
      // Each memory was saved only after whoever added it confirmed everyone in it agreed.
      memories: store.keepsakes.map((k) => ({ id: k.id, name: k.name, confirmedBy: memberName(k.addedBy), confirmedAt: k.createdAt })),
      history: store.consentLog
        .slice(-100)
        .reverse()
        .map((entry) => ({ ...entry, byName: memberName(entry.by) })),
    });
  });

  // ---- Keepsake editing ----------------------------------------------------------------

  app.patch("/api/keepsakes/:id", (req, res) => {
    const patch = {};
    if (typeof req.body?.name === "string" && text(req.body.name, 80)) patch.name = text(req.body.name, 80);
    if (typeof req.body?.description === "string") patch.description = text(req.body.description, 400);
    if (typeof req.body?.from === "string") patch.from = text(req.body.from, 60);
    if (typeof req.body?.introLine === "string" && text(req.body.introLine, 200)) patch.introLine = text(req.body.introLine, 200);
    if (typeof req.body?.story === "string") patch.story = text(req.body.story, 1200);
    if (Array.isArray(req.body?.people)) {
      patch.people = req.body.people.filter((id) => store.members.some((m) => m.id === id));
    }
    const keepsake = store.updateKeepsake(req.params.id, patch);
    if (!keepsake) return res.status(404).json({ error: "Not found." });
    res.json(publicKeepsake(keepsake));
  });

  // ---- Everyday questions ----------------------------------------------------------------
  //
  // The loop that spares everyone: the wearer asks something, nobody has answered it, the
  // family is told, someone records an answer once, and from then on the glasses give it.

  const publicAnswer = (a) => ({ ...a, audio: mediaUrl(a.audio), addedByName: memberName(a.addedBy) });

  app.get("/api/questions", (_req, res) => {
    const open = new Map();
    for (const e of store.events) {
      if (e.type !== "question" || e.answerId) continue;
      const key = `${e.keepsakeId ?? ""}|${questionKey(e.question)}`;
      const entry = open.get(key) ?? {
        question: e.question,
        keepsakeId: e.keepsakeId ?? null,
        keepsake: e.keepsakeId ? (store.keepsakes.find((k) => k.id === e.keepsakeId)?.name ?? "") : "",
        count: 0,
        firstAt: e.at,
        lastAt: e.at,
      };
      entry.count++;
      entry.lastAt = e.at;
      open.set(key, entry);
    }
    // How often each recorded answer has spared someone repeating themselves.
    const used = new Map();
    for (const e of store.events) {
      if (e.type === "question" && e.answerId) used.set(e.answerId, (used.get(e.answerId) ?? 0) + 1);
    }
    // A question someone has answered since it was asked is no longer waiting.
    for (const [key, entry] of open) {
      const candidates = [...(store.keepsake(entry.keepsakeId)?.answers ?? []), ...store.bank];
      if (matchQuestionLocally(entry.question, candidates)) open.delete(key);
    }
    res.json({
      careSignals: store.profile.consent.careSignals,
      open: [...open.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)),
      answered: store.bank.map((a) => ({ ...publicAnswer(a), timesUsed: used.get(a.id) ?? 0 })).reverse(),
    });
  });

  app.post("/api/questions", upload.single("audio"), (req, res) => {
    const question = text(req.body.question, 200);
    const words = text(req.body.text, 600);
    if (!question || (!words && !req.file)) {
      if (req.file) store.removeMedia(req.file.filename);
      return res.status(400).json({ error: "Please record an answer or type one." });
    }
    const answer = {
      id: store.newId("a"),
      question,
      text: words,
      speaker: text(req.body.speaker, 60),
      audio: req.file?.filename ?? null,
      addedBy: text(req.body.addedBy, 40) || null,
      createdAt: new Date().toISOString(),
    };
    store.bank.push(answer);
    store.save();
    const by = memberName(answer.addedBy) || answer.speaker;
    notify({
      type: "answer_added",
      title: by ? `${by} recorded an answer` : "An answer was recorded",
      body: `“${question}”. From now on, ${store.profile.wearerName || "they"} will hear it whenever they ask.`,
      question,
      byMember: answer.addedBy,
    });
    res.status(201).json(publicAnswer(answer));
  });

  app.delete("/api/questions/:id", (req, res) => {
    const answer = store.bank.find((a) => a.id === req.params.id);
    if (!answer) return res.status(404).json({ error: "Not found." });
    store.removeMedia(answer.audio);
    store.bank = store.bank.filter((a) => a.id !== answer.id);
    store.save();
    res.status(204).end();
  });

  // ---- Dashboard -----------------------------------------------------------------------

  function totals(events) {
    const looks = events.filter((e) => e.type === "look");
    const questions = events.filter((e) => e.type === "question");
    const answered = questions.filter((e) => e.answerId).length;
    const memories = looks.filter((e) => e.matchId).length;
    const activeDays = new Set(
      events.filter((e) => (e.type === "look" && e.matchId) || e.type === "question").map((e) => e.at.slice(0, 10)),
    ).size;
    return {
      looks: looks.length,
      memoriesPlayed: memories,
      questionsAsked: questions.length,
      questionsAnswered: answered,
      answerRate: questions.length ? answered / questions.length : null,
      activeDays,
    };
  }

  app.get("/api/stats", (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const now = Date.now();
    const inRange = (from, to) => store.events.filter((e) => Date.parse(e.at) >= from && Date.parse(e.at) < to);
    const current = inRange(now - days * DAY, now + 1);
    const previous = inRange(now - 2 * days * DAY, now - days * DAY);
    const summary = buildSummary({ events: store.events, keepsakes: store.keepsakes, days, now });

    // When in the day the wearer turns to their memories. Hours are the server's local time.
    const hourly = Array.from({ length: 24 }, () => 0);
    for (const e of current) {
      if ((e.type === "look" && e.matchId) || e.type === "question") hourly[new Date(e.at).getHours()]++;
    }

    const looks = current.filter((e) => e.type === "look");
    const timings = looks.filter((e) => Number.isFinite(e.latencyMs)).map((e) => e.latencyMs);

    const heartOn = store.profile.consent.heartRate;
    const keepsakes = store.keepsakes.map((k) => {
      const plays = looks.filter((e) => e.matchId === k.id);
      const beats = heartOn ? current.filter((e) => e.type === "heart_response" && e.keepsakeId === k.id && e.heart) : [];
      const asked = current.filter((e) => e.type === "question" && e.keepsakeId === k.id);
      return {
        ...publicKeepsake(k),
        addedByName: memberName(k.addedBy),
        plays: plays.length,
        questions: asked.length,
        unanswered: asked.filter((e) => !e.answerId).length,
        lastPlayedAt: plays.length ? plays[plays.length - 1].at : null,
        // Heart rate across the times it was open: how many, and how far above resting it went.
        heart: typical(beats.map((e) => summarise(e.heart))),
      };
    });

    res.json({
      days,
      wearerName: store.profile.wearerName,
      careSignals: store.profile.consent.careSignals,
      heartRate: heartOn,
      totals: totals(current),
      previous: totals(previous),
      daily: summary.daily.map((d) => ({
        ...d,
        looks: looks.filter((e) => e.at.startsWith(d.day)).length,
      })),
      hourly,
      keepsakes: keepsakes.sort((a, b) => b.plays - a.plays),
      neverPlayed: keepsakes.filter((k) => k.plays === 0).map((k) => ({ id: k.id, name: k.name })),
      members: store.members.map(publicMember),
      recognition: {
        medianMs: median(timings),
        p90Ms: median(timings, 0.9),
        matchRate: looks.length ? looks.filter((e) => e.matchId).length / looks.length : null,
      },
      unansweredQuestions: summary.unansweredQuestions,
      nudges: summary.nudges,
      unknownObjects: summary.unknownObjects,
      pauses: summary.pauses,
      lastSeenAt: store.events.length ? store.events[store.events.length - 1].at : null,
    });
  });

  app.get("/api/activity", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 300);
    // With `keepsake`, only what happened with that memory.
    const only = text(req.query.keepsake, 40);
    const items = [];
    for (let i = store.events.length - 1; i >= 0 && items.length < limit; i--) {
      const event = store.events[i];
      if (only && (event.keepsakeId ?? event.matchId) !== only) continue;
      const described = describe(event, nameOf, store.profile.wearerName);
      if (described) items.push({ at: event.at, type: event.type, keepsakeId: event.keepsakeId ?? event.matchId ?? null, ...described });
    }
    res.json(items);
  });

  // Heart rate each time one memory was open, newest first, with the readings for a chart.
  app.get("/api/keepsakes/:id/heart", (req, res) => {
    if (!store.keepsake(req.params.id)) return res.status(404).json({ error: "Not found." });
    const enabled = store.profile.consent.heartRate;
    const events = enabled ? store.events.filter((e) => e.type === "heart_response" && e.keepsakeId === req.params.id && e.heart) : [];
    const sessions = events.map((e) => {
      const summary = summarise(e.heart);
      return { at: e.at, ...summary, text: describeHeart(summary, store.profile.wearerName), everySec: e.heart.everySec, samples: e.heart.samples, source: e.heart.source };
    });
    res.json({ enabled, typical: typical(sessions), sessions: sessions.slice(-20).reverse() });
  });

  // ---- Hooks called from the glasses loop ----------------------------------------------

  return {
    publicPerson,

    clearHeartNotices() {
      store.notifications = store.notifications.filter((n) => n.type !== "heart_lifted");
      store.save();
    },

    keepsakeAdded(keepsake) {
      const by = memberName(keepsake.addedBy);
      notify({
        type: "keepsake_added",
        title: by ? `${by} added a memory` : "A memory was added",
        body: `${keepsake.name}${keepsake.voiceNote ? ", with a voice message" : ""}. The glasses will offer it whenever they see it.`,
        keepsakeId: keepsake.id,
        byMember: keepsake.addedBy,
      });
    },

    /** Its self-test took a picture of a look-alike for a memory. */
    mightBeMistaken(keepsake) {
      notify({
        type: "lookalike",
        title: `${keepsake.name} could be confused with one like it`,
        body: `In a test, the glasses took a similar object for ${nameOf(keepsake.id)}. A close-up photo of something only yours has, such as a mark, a label, wear or the underside, helps them tell it apart.`,
        key: `lookalike|${keepsake.id}`,
        quietFor: 30 * DAY,
        keepsakeId: keepsake.id,
      });
    },

    answerAdded(keepsake, answer) {
      const by = memberName(answer.addedBy) || answer.speaker;
      notify({
        type: "answer_added",
        title: by ? `${by} recorded an answer` : "An answer was recorded",
        body: `“${answer.question}”, about ${nameOf(keepsake.id)}. ${wearer()} will hear it whenever they ask.`,
        keepsakeId: keepsake.id,
        question: answer.question,
        byMember: answer.addedBy,
      });
    },

    questionAsked(keepsake, question, answer) {
      if (!store.profile.consent.careSignals) return;
      const key = questionKey(question);
      if (!answer) {
        notify({
          type: "unanswered",
          title: `${wearer()} has a question for the family`,
          body: `“${question}”${about(keepsake)}. Answer it once, and they will hear your answer every time they ask.`,
          key: `unanswered|${keepsake?.id ?? ""}|${key}`,
          keepsakeId: keepsake?.id ?? null,
          question,
        });
      }
      const since = Date.now() - 30 * 60 * 1000;
      const repeats = store.events.filter(
        (e) =>
          e.type === "question" &&
          (e.keepsakeId ?? null) === (keepsake?.id ?? null) &&
          Date.parse(e.at) >= since &&
          (answer ? e.answerId === answer.id : questionKey(e.question) === key),
      ).length;
      if (repeats >= 3) {
        notify({
          type: "repeat",
          title: `${wearer()} might like to hear from someone`,
          body: `They have asked “${question}” ${repeats} times in half an hour, which can be a sign of feeling unsettled. A call or a visit might help. This is a gentle prompt, not a diagnosis.`,
          key: `repeat|${keepsake?.id ?? ""}|${answer?.id ?? key}`,
          quietFor: 2 * 60 * 60 * 1000,
          keepsakeId: keepsake?.id ?? null,
          question,
        });
      }
    },

    looked(result) {
      if (!store.profile.consent.careSignals) return;
      if (result.matchId) {
        notify({
          type: "memory_played",
          title: `${wearer()} spent a moment with a memory`,
          body: `They picked up ${nameOf(result.matchId)} and heard the message that goes with it.`,
          key: `played|${result.matchId}|${new Date().toISOString().slice(0, 10)}`,
          keepsakeId: result.matchId,
        });
        return;
      }
      if (!store.profile.consent.logUnknownObjects || !result.objectLabel) return;
      const since = Date.now() - 7 * DAY;
      const seen = store.events.filter(
        (e) => e.type === "look" && !e.matchId && e.objectLabel === result.objectLabel && Date.parse(e.at) >= since,
      ).length;
      if (seen >= 3) {
        notify({
          type: "unknown_object",
          title: `${wearer()} keeps coming back to something`,
          body: `They have looked at ${result.objectLabel} ${seen} times this week. If it means something to them, it could hold a memory.`,
          key: `unknown|${result.objectLabel}`,
          quietFor: 7 * DAY,
        });
      }
    },

    clientEvent(type, event) {
      if (type === "heart_response" && event?.heart) {
        const summary = summarise(event.heart);
        if (summary.kind !== "lifted") return;
        notify({
          type: "heart_lifted",
          title: `${wearer()}'s heart rate rose while a memory was open`,
          body: `${summary.source === "simulated" ? "Simulated reading. " : ""}It went from ${summary.restingBpm} to ${summary.peakBpm} beats a minute while ${nameOf(event.keepsakeId)} was open. Moving or talking can do that too.`,
          key: `heart|${event.keepsakeId}|${new Date().toISOString().slice(0, 10)}`,
          keepsakeId: event.keepsakeId,
        });
        return;
      }
      if (type === "low_battery") {
        notify({
          type: "low_battery",
          title: "The glasses need charging",
          body: `Their battery is low. Pop them on the charger so they're ready when ${store.profile.wearerName || "they"} next need${store.profile.wearerName ? "s" : ""} them.`,
          key: "low_battery",
          quietFor: 6 * 60 * 60 * 1000,
        });
      }
    },

    /** Wearer-derived notices go when the family wipes the activity history. */
    clearWearerNotices() {
      const derived = new Set(["unanswered", "repeat", "memory_played", "unknown_object", "low_battery", "heart_lifted"]);
      store.notifications = store.notifications.filter((n) => !derived.has(n.type));
      store.save();
    },
  };
}
