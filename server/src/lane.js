// Memory lanes: a memory's photos and videos made into a slow film, with its voice message
// as the soundtrack, to watch on the phone or the glasses. A memory with photos or a video has
// one (keepsake.lane); a memory with only a voice message has none. The film itself is drawn
// by the family app and the phone (family/src/lane); the server keeps the plan it follows.
//
// As everywhere else, the model only arranges what the family made: which memories, in what
// order, which photo goes with which moment of the family's own voice message, and which of a
// few built-in kinds of quiet music sits underneath. It writes nothing the wearer hears or
// reads. The renderer keeps every transition slow and soft whatever the plan says.
import fs from "node:fs";
import path from "node:path";
import { aiMode } from "./ai.js";
import { cloudinaryEnabled, uploadDisplayClip } from "./cloudinary.js";
import { geminiJson, inlineMedia } from "./gemini.js";

export const MUSIC = ["warm", "tender", "bright", "none"];
export const AMBIENCE = ["none", "waves", "breeze"];
export const PACE = ["gentle", "slower"];
export const MOTION = ["push-in", "drift-left", "drift-right", "still"];

const MAX_PHOTOS_TO_MODEL = 30;
// Gemini takes up to 20 MB inline per request. Stay well under it.
const MAX_INLINE_BYTES = 14 * 1024 * 1024;
const PLAN_TIMEOUT_MS = Number(process.env.ML_LANE_TIMEOUT_MS || 90_000);
const HISTORY = 10;

export class LaneError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const SYSTEM = `You arrange a "memory lane": a slow, gentle film for an older person living with memory loss, made only from photos, videos and voice messages their family recorded. It is watched with a relative or carer, on a phone or on glasses.

You are given the memory: its id, its name, who it is from, sometimes the family's written words, its photos and videos (each with an id) and its voice message. Decide:

- Which of its photos and videos to show and when. Include all of them unless the family asks otherwise. Listen to the voice message and put each photo at the moment it fits: when a place, a person or an object in the photo is mentioned. at_seconds counts from the start of that memory's own voice message; the first shot of a memory is at 0. Leave at least 7 seconds between shots. Use each photo at most once, and only photos that belong to that memory.
- focus_x and focus_y: where the main subject of the photo is (a face, a person, the object), as fractions of the width and height from the top left. Transitions line subjects up, so be accurate. Use 0.5 and 0.45 for videos and photos with no clear subject.
- motion: "push-in" (a slow move towards the subject) suits most photos; "drift-left" or "drift-right" suits wide places; "still" suits close-up portraits and videos.
- music: "warm" (soft piano and strings, the default), "tender" (slower and more wistful), "bright" (lighter, for happy summer days) or "none". ambience: "none" (the default), "waves" (a calm sea, only if the memory is by the sea) or "breeze" (open air, gardens, countryside).
- pace: "gentle" by default, "slower" if the family asks for it slower or calmer.
- note: one or two plain sentences to the family about what you did and why, such as which photo you placed where. Only the family reads it.

Everything must stay calm: nothing sudden, nothing fast. You only choose and arrange; you never write words for the wearer.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    music: { type: "STRING", format: "enum", enum: MUSIC },
    ambience: { type: "STRING", format: "enum", enum: AMBIENCE },
    pace: { type: "STRING", format: "enum", enum: PACE },
    note: { type: "STRING" },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          memory_id: { type: "STRING" },
          shots: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                media_id: { type: "STRING" },
                at_seconds: { type: "NUMBER" },
                focus_x: { type: "NUMBER" },
                focus_y: { type: "NUMBER" },
                motion: { type: "STRING", format: "enum", enum: MOTION },
              },
              required: ["media_id", "at_seconds", "focus_x", "focus_y", "motion"],
            },
          },
        },
        required: ["memory_id", "shots"],
      },
    },
  },
  required: ["music", "ambience", "pace", "note", "segments"],
};

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const clamp = (value, low, high, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

/** Photos or a video to make a film from. The photos of the object itself are never in it. */
export const hasFilmMedia = (keepsake) => keepsake.memoryPhotos.length > 0 || Boolean(keepsake.clip);

/** What a memory's lane is made from. A list of one: the plan keeps a segment per memory. */
function materials(keepsake) {
  return [
    {
      keepsake,
      media: [
        ...keepsake.memoryPhotos.map((file) => ({ file, kind: "photo" })),
        ...(keepsake.clip ? [{ file: keepsake.clip, kind: "video" }] : []),
      ],
    },
  ];
}

/** Short ids for the model ("p1", "v2"), the same every time for the same memories. */
function handlesFor(mats) {
  const byId = new Map();
  const byFile = new Map();
  let n = 0;
  for (const { keepsake, media } of mats) {
    for (const item of media) {
      const id = `${item.kind === "video" ? "v" : "p"}${++n}`;
      const handle = { id, keepsakeId: keepsake.id, ...item };
      byId.set(id, handle);
      byFile.set(item.file, handle);
    }
  }
  return { byId, byFile };
}

const MOTIONS_IN_TURN = ["push-in", "drift-right", "push-in", "drift-left"];

function simpleShots({ media }) {
  return media.map((item, i) => ({
    file: item.file,
    kind: item.kind,
    // No time: the renderer spreads them evenly across the voice message.
    at: null,
    focus: [0.5, 0.45],
    motion: item.kind === "video" ? "still" : MOTIONS_IN_TURN[i % MOTIONS_IN_TURN.length],
  }));
}

/** The photos in the order they were added, evenly across the voice message. */
export function simplePlan(mats, note = "") {
  return {
    music: "warm",
    ambience: "none",
    pace: "gentle",
    note,
    segments: mats.filter((m) => m.media.length).map((m) => ({ keepsakeId: m.keepsake.id, shots: simpleShots(m) })),
  };
}

/** Keeps only what refers to real memories and media, with every number in range. */
export function sanitisePlan(raw, mats, handles) {
  if (!raw || !Array.isArray(raw.segments)) return null;
  const byKeepsake = new Map(mats.map((m) => [m.keepsake.id, m]));
  const used = new Set();
  const segments = [];
  for (const segment of raw.segments) {
    const mat = byKeepsake.get(segment?.memory_id);
    if (!mat || used.has(mat.keepsake.id)) continue;
    used.add(mat.keepsake.id);
    const seen = new Set();
    let shots = [];
    for (const shot of Array.isArray(segment.shots) ? segment.shots : []) {
      const handle = handles.byId.get(shot?.media_id);
      // A photo from another memory would put words to a picture they were not about.
      if (!handle || handle.keepsakeId !== mat.keepsake.id || seen.has(handle.file)) continue;
      seen.add(handle.file);
      shots.push({
        file: handle.file,
        kind: handle.kind,
        at: clamp(shot.at_seconds, 0, 900, null),
        focus: [clamp(shot.focus_x, 0.05, 0.95, 0.5), clamp(shot.focus_y, 0.05, 0.95, 0.45)],
        motion: pick(shot.motion, MOTION, "push-in"),
      });
    }
    if (!shots.length) shots = simpleShots(mat);
    if (shots.length) segments.push({ keepsakeId: mat.keepsake.id, shots });
  }
  if (!segments.length) return null;
  return {
    music: pick(raw.music, MUSIC, "warm"),
    ambience: pick(raw.ambience, AMBIENCE, "none"),
    pace: pick(raw.pace, PACE, "gentle"),
    note: String(raw.note ?? "").trim().slice(0, 400),
    segments,
  };
}

/** The current plan as the model sees it: its own ids, not file names. */
function planForModel(plan, handles) {
  return {
    music: plan.music,
    ambience: plan.ambience,
    pace: plan.pace,
    segments: plan.segments.map((segment) => ({
      memory_id: segment.keepsakeId,
      shots: segment.shots
        .map((shot) => ({
          media_id: handles.byFile.get(shot.file)?.id,
          at_seconds: shot.at,
          focus_x: shot.focus[0],
          focus_y: shot.focus[1],
          motion: shot.motion,
        }))
        .filter((shot) => shot.media_id),
    })),
  };
}

function modelParts({ mats, handles, store, current, request, withAudio }) {
  const parts = [];
  let bytes = 0;
  let photos = 0;
  const add = (part) => {
    if (!part) return false;
    const size = part.inlineData.data.length;
    if (bytes + size > MAX_INLINE_BYTES) return false;
    bytes += size;
    parts.push(part);
    return true;
  };
  for (const { keepsake, media } of mats) {
    const from = keepsake.from || store.members.find((m) => m.id === keepsake.addedBy)?.name || "";
    parts.push({
      text:
        `Memory id "${keepsake.id}": "${keepsake.name}"` +
        (from ? `, from ${from}.` : ".") +
        (keepsake.story ? ` In the family's words: "${keepsake.story}"` : ""),
    });
    for (const item of media) {
      const id = handles.byFile.get(item.file).id;
      if (item.kind === "video") {
        parts.push({ text: `Video id "${id}": a short video clip from this memory (not shown to you).` });
        continue;
      }
      const label = { text: `Photo id "${id}":` };
      parts.push(label);
      const sent = photos < MAX_PHOTOS_TO_MODEL && add(inlineMedia(item.file, store.mediaDir));
      if (sent) photos++;
      else label.text = `Photo id "${id}" (not shown to you).`;
    }
    const label = { text: `The voice message for "${keepsake.id}":` };
    if (keepsake.voiceNote && withAudio) {
      parts.push(label);
      if (!add(inlineMedia(keepsake.voiceNote, store.mediaDir))) label.text = "Its voice message could not be sent to you.";
    } else {
      parts.push({ text: keepsake.voiceNote ? "Its voice message could not be sent to you." : "It has no voice message." });
    }
  }
  if (current) {
    parts.push({ text: `This is the lane as it is now:\n${JSON.stringify(planForModel(current, handles))}` });
    parts.push({ text: `The family asked for this change: "${request}". Make it, keep everything else as it is, and say in the note what you changed.` });
  } else {
    parts.push({ text: "That is everything. Arrange the lane." });
  }
  return parts;
}

/**
 * A new plan for a memory's lane, or a revision of `current` asked for in the family's words.
 * Without a model, a new lane gets the simple plan and a change in words is refused.
 */
export async function planLane({ store, keepsake, current = null, request = "" }) {
  const mats = materials(keepsake);
  if (!hasFilmMedia(keepsake)) throw new LaneError("Add a photo or a video to make a memory lane.", 400);
  if (aiMode() !== "gemini") {
    if (current) {
      throw new LaneError(
        "Changes in words need the Gemini model, which isn't set up on this server. You can still change the music, the sound and the pace.",
        409,
      );
    }
    return simplePlan(mats, "Photos are in the order they were added, spread across the voice message.");
  }

  const handles = handlesFor(mats);
  const ask = (withAudio) =>
    geminiJson({
      system: SYSTEM,
      parts: modelParts({ mats, handles, store, current, request, withAudio }),
      schema: SCHEMA,
      timeoutMs: PLAN_TIMEOUT_MS,
      // A plan weighs many photos and words, so it is given more thought than a quick look.
      thinking: "low",
      // Room for the model's own thinking as well as a plan for a dozen memories.
      maxOutputTokens: 8000,
    });

  let raw;
  try {
    try {
      raw = await ask(true);
    } catch (error) {
      // Usually a recording in a format the model would not take. Try from the photos and words.
      if (!/ 400\b/.test(String(error?.message))) throw error;
      raw = await ask(false);
    }
  } catch (error) {
    console.warn("lane plan failed:", error?.message ?? error);
    if (current) throw new LaneError("The model didn't answer just now. Please try again in a minute.", 503);
    return simplePlan(mats, "The model didn't answer in time, so this is a simple arrangement. Ask for a change to try again.");
  }
  const plan = sanitisePlan(raw, mats, handles);
  if (plan) return plan;
  if (current) throw new LaneError("That change didn't come back in a usable form. Try saying it another way.", 502);
  return simplePlan(mats, "The model's arrangement couldn't be used, so this is a simple one. Ask for a change to try again.");
}


// ---- Routes ------------------------------------------------------------------------------

const newLane = (plan) => ({ plan, version: 1, history: [], lens: null });

export function registerLanes(app, { store, upload, mediaUrl, films = null }) {
  // A change in words takes a while; a second one at the same time would be lost.
  const busy = new Set();

  // Memories an older version saved with photos or a video but no lane get the simple one.
  let added = false;
  for (const keepsake of store.keepsakes) {
    if (keepsake.lane || !hasFilmMedia(keepsake)) continue;
    keepsake.lane = newLane(simplePlan(materials(keepsake), "Photos are in the order they were added, spread across the voice message."));
    added = true;
  }
  if (added) store.save();

  const fromOf = (keepsake) =>
    keepsake.from || store.members.find((m) => m.id === keepsake.addedBy)?.name || "";

  /** What the player needs, or null for a memory with no lane. */
  function publicLane(keepsake) {
    const lane = keepsake.lane;
    if (!lane) return null;
    const own = new Set([...keepsake.memoryPhotos, keepsake.clip].filter(Boolean));
    const segments = lane.plan.segments
      .filter((segment) => segment.keepsakeId === keepsake.id)
      .map((segment) => ({
        keepsakeId: keepsake.id,
        name: keepsake.name,
        from: fromOf(keepsake),
        voice: mediaUrl(keepsake.voiceNote),
        // The family's written words, shown as the voice message plays.
        words: keepsake.story ?? "",
        shots: segment.shots
          .filter((shot) => own.has(shot.file))
          .map((shot) => ({ src: mediaUrl(shot.file), kind: shot.kind, at: shot.at, focus: shot.focus, motion: shot.motion })),
      }))
      .filter((segment) => segment.shots.length);
    return {
      id: keepsake.id,
      name: keepsake.name,
      music: lane.plan.music,
      ambience: lane.plan.ambience,
      pace: lane.plan.pace,
      note: lane.plan.note,
      segments,
      version: lane.version,
      // The small copy for the glasses: a silent video for the display and its sound apart.
      lens: lane.lens
        ? { video: mediaUrl(lane.lens.video), audio: mediaUrl(lane.lens.audio), version: lane.lens.version }
        : null,
      // With Cloudinary set up the server makes the glasses copy itself, after every change.
      lensByServer: Boolean(films?.enabled()),
      lensMaking: films?.tunnelState(keepsake).making ?? false,
      lensError: films?.tunnelState(keepsake).error ?? null,
      canUndo: lane.history.length > 0,
    };
  }

  function setPlan(keepsake, plan) {
    const lane = keepsake.lane;
    lane.history = [...lane.history, lane.plan].slice(-HISTORY);
    lane.plan = plan;
    lane.version++;
    store.save();
    films?.tunnel(keepsake);
  }

  /** The memory, if it is there and has a lane; otherwise answers 404 and returns null. */
  const withLane = (req, res) => {
    const keepsake = store.keepsake(req.params.id);
    if (keepsake?.lane) return keepsake;
    res.status(404).json({ error: keepsake ? "This memory has no photos or video, so it has no lane." : "Not found." });
    return null;
  };

  const fail = (res, error) => {
    if (error instanceof LaneError) return res.status(error.status).json({ error: error.message });
    throw error;
  };

  const route = "/api/keepsakes/:id/lane";

  app.get(route, (req, res) => {
    const keepsake = withLane(req, res);
    if (keepsake) res.json(publicLane(keepsake));
  });

  app.post(`${route}/revise`, async (req, res) => {
    const keepsake = withLane(req, res);
    if (!keepsake) return;
    const request = String(req.body?.request ?? "").trim().slice(0, 300);
    if (!request) return res.status(400).json({ error: "Say what you would like changed." });
    if (busy.has(keepsake.id)) return res.status(409).json({ error: "A change is already being made. Wait for it to finish." });
    busy.add(keepsake.id);
    try {
      const plan = await planLane({ store, keepsake, current: keepsake.lane.plan, request });
      if (store.keepsake(keepsake.id) !== keepsake) return res.status(404).json({ error: "Not found." });
      setPlan(keepsake, plan);
      res.json(publicLane(keepsake));
    } catch (error) {
      return fail(res, error);
    } finally {
      busy.delete(keepsake.id);
    }
  });

  // Changes made by hand: the music, the sound around it and the pace.
  app.patch(route, (req, res) => {
    const keepsake = withLane(req, res);
    if (!keepsake) return;
    const body = req.body ?? {};
    const current = keepsake.lane.plan;
    const plan = { ...current };
    if (MUSIC.includes(body.music)) plan.music = body.music;
    if (AMBIENCE.includes(body.ambience)) plan.ambience = body.ambience;
    if (PACE.includes(body.pace)) plan.pace = body.pace;
    if (["music", "ambience", "pace"].some((key) => plan[key] !== current[key])) setPlan(keepsake, plan);
    res.json(publicLane(keepsake));
  });

  app.post(`${route}/undo`, (req, res) => {
    const keepsake = withLane(req, res);
    if (!keepsake) return;
    if (busy.has(keepsake.id)) return res.status(409).json({ error: "A change is being made. Wait for it to finish." });
    const lane = keepsake.lane;
    const previous = lane.history.pop();
    if (!previous) return res.status(409).json({ error: "There is nothing to undo." });
    lane.plan = previous;
    lane.version++;
    store.save();
    films?.tunnel(keepsake);
    res.json(publicLane(keepsake));
  });

  // Asks for the glasses copy to be made again by Cloudinary: after a failure, or by hand.
  app.post(`${route}/lens/make`, (req, res) => {
    const keepsake = withLane(req, res);
    if (!keepsake) return;
    if (!films?.tunnel(keepsake)) return res.status(409).json({ error: "This server makes glasses copies in the family app, not with Cloudinary." });
    res.status(202).json(publicLane(keepsake));
  });

  // The glasses copy, made in the family app's browser: an MP4 small enough for the display
  // and, apart from it, the sound, which the phone plays to the glasses' speakers.
  const lensFiles = upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]);
  app.post(`${route}/lens`, lensFiles, async (req, res) => {
    const files = req.files ?? {};
    const video = files.video?.[0];
    const audio = files.audio?.[0];
    const discard = () => [video, audio].forEach((f) => f && fs.rmSync(f.path, { force: true }));
    const keepsake = store.keepsake(req.params.id);
    if (!keepsake?.lane) {
      discard();
      return res.status(404).json({ error: "Not found." });
    }
    if (!video || !audio || path.extname(video.filename) !== ".mp4" || !video.mimetype.startsWith("video/mp4")) {
      discard();
      return res.status(400).json({ error: "The glasses copy needs an MP4 video and its sound." });
    }
    // The glasses fetch the video themselves, and real ones are expected to need a public https
    // address. With Cloudinary set up, that is where it is served from; otherwise from here.
    let shown = video.filename;
    if (cloudinaryEnabled()) {
      try {
        shown = await uploadDisplayClip(video.path);
        fs.rmSync(video.path, { force: true });
      } catch (error) {
        console.warn(String(error));
      }
    }
    if (store.keepsake(keepsake.id) !== keepsake || !keepsake.lane) {
      discard();
      return res.status(404).json({ error: "Not found." });
    }
    const lane = keepsake.lane;
    if (lane.lens) {
      store.removeMedia(lane.lens.video);
      store.removeMedia(lane.lens.audio);
    }
    const version = Number(req.body?.version);
    lane.lens = {
      video: shown,
      audio: audio.filename,
      version: Number.isInteger(version) ? version : lane.version,
      madeAt: new Date().toISOString(),
    };
    store.save();
    res.status(201).json(publicLane(keepsake));
  });

  return {
    publicLane,
    /** Plans the lane of a memory just added, if it has photos or a video. */
    async attach(keepsake) {
      if (!hasFilmMedia(keepsake)) return;
      keepsake.lane = newLane(await planLane({ store, keepsake }));
      store.save();
      films?.tunnel(keepsake);
    },
  };
}
