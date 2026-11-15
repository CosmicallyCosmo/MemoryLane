#!/usr/bin/env node
// Builds the demo household from the folder of demo recordings: Maya and Jake with their
// profile photos, Maya's hello (her recording and her video), Jake's memory lane, and six
// memories, each an object's photos with a relative's voice message and a video:
//   the elephant keychain (Maya, Sri Lanka), the graduation photo (Jake, graduation day),
//   the garden lantern (Jake, decorating the garden), the snowman chocolate box (Maya,
//   Christmas), the 50th birthday card (Maya, the party) and the basset hound card (Jake,
//   walks with Fluffy).
//
// Everything goes through the server's own code, as if the family had added it in the family
// app. It writes to its own folder and never touches server/data:
//
//   npm run seed:recordings -- <folder of recordings>   builds server/data-recordings
//   npm run start:recordings                             runs the server on it
//   npm run seed:recordings -- <folder> --into <dir>     builds somewhere else
//
// The folder can also be given as ML_RECORDINGS. The recordings themselves are never in git.
//
// Then a fortnight of the glasses being used, MADE UP: the memories looked at and replayed,
// questions asked (some answered, some waiting), and the notifications that came of them. The
// household is set up as if a fortnight ago. Heart rate is left out: it needs switching on.
// The wearer's own lines ("What's this?", "Who's Maya?", "Yes, please.") are not added: they
// are what the person wearing the glasses says.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const intoIndex = args.indexOf("--into");
const target = path.resolve(intoIndex >= 0 && args[intoIndex + 1] ? args[intoIndex + 1] : path.join(root, "data-recordings"));
const fromArg = args.find((arg, i) => !arg.startsWith("--") && (intoIndex < 0 || i !== intoIndex + 1)) ?? process.env.ML_RECORDINGS;
if (!fromArg) {
  console.error("Say where the recordings are: npm run seed:recordings -- <folder>");
  process.exit(1);
}
const source = path.resolve(fromArg);

// ---- The files, by the names they were given -------------------------------------------------
const FILES = {
  keychainPhoto: "elephant object.jpeg",
  keychainVoice: "2.chi its maya.mp3",
  keychainVideo: "1vid srilanka.mp4",
  graduationPhoto: "3 still picture graduation.png",
  graduationVoice: "6. jake graduated.mp3",
  graduationVideo: "4vid grad video.mp4",
  mayaHello: "4. im your daugher.mp3",
  mayaHelloVideo: "2vid maya holding hands.mp4",
  // Cropped from the garden video, where both look at the camera.
  mayaPhoto: "maya profile.jpg",
  jakePhoto: "jake profile.jpg",
  gardenPhotos: ["garden object 1.jpeg", "garden object 2.jpeg", "garden object 3.jpeg"],
  gardenVoice: "garden jake.mp3",
  gardenVideo: "garden video.mp4",
  christmasPhotos: ["christmas object 1.jpeg", "christmas object 2.jpeg", "christmas object 3.jpeg"],
  christmasVoice: "christmas maya.mp3",
  christmasVideo: "christmas video.mp4",
  birthdayPhotos: ["birthday object 1.jpeg", "birthday object 2.jpeg", "birthday object 3.jpeg"],
  birthdayVoice: "birthday maya.mp3",
  birthdayVideo: "birthday video.mp4",
  dogPhotos: ["dog walk object 1.jpeg", "dog walk object 2.jpeg"],
  dogVoice: "dog walk jake.mp3",
  dogVideo: "dog walk video.mp4",
};
// Jake's memory lane on Cloudinary: year, title and public id of each clip.
const JAKE_LANE = [
  [1998, "The day you came home", "memorylane/lane/knvlxhekizazges5cnwe"],
  [1999, "First steps", "memorylane/lane/ysodxwyztwj0qiirwf9x"],
  [2001, "Meeting your sister", "memorylane/lane/tlbejkjqak395d0pl5ab"],
  [2003, "First day of school", "memorylane/lane/qxk2nbsknggzitrakuv9"],
  [2005, "Learning to ride", "memorylane/lane/fi2nwkxrmcl0zouxungm"],
  [2008, "Summer at the lake", "memorylane/lane/uho3fmraelzl5vw9lfzf"],
  [2009, "Christmas morning", "memorylane/lane/k8nev3c2jf5aisxpcdsg"],
  [2011, "The school play", "memorylane/lane/atxjkz3gwtxgmtarspmv"],
  [2014, "The cup final", "memorylane/lane/adru1dbve9la8aixturt"],
  [2016, "Eighteen", "memorylane/lane/iq2fl71iel8c9vwopryg"],
  [2020, "Sri Lanka", "memorylane/lane/uilkslqrxmw2urx1oatl"],
  [2020, "Graduation day", "memorylane/lane/kf5cmb1tu8akf4vnygv8"],
  [2026, "With Mum, today", "memorylane/lane/dfj8yycjyg3dogt4fhbr"],
];
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg", ".mp4": "video/mp4" };

const missing = Object.values(FILES).flat().filter((name) => !fs.existsSync(path.join(source, name)));
if (missing.length) {
  console.error(`These recordings are not in ${source}:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
/** The file or files to upload. For a photo, a smaller copy beside it ("name.small.jpg") is used if there. */
const file = (key) => (Array.isArray(FILES[key]) ? FILES[key].map(named) : named(FILES[key]));
const named = (name) => {
  const small = name.replace(/\.[^.]+$/, ".small.jpg");
  if (TYPES[path.extname(name)].startsWith("image/") && fs.existsSync(path.join(source, small))) name = small;
  return new File([fs.readFileSync(path.join(source, name))], name, { type: TYPES[path.extname(name).toLowerCase()] });
};

// ---- Safety: only ever replace a folder that holds nothing but Memory Lane data -------------
if (target === path.join(root, "data")) {
  console.error("Refusing to replace server/data. Use the default (data-recordings) or --into.");
  process.exit(1);
}
// sim.sh keeps its logs in dev/ beside the data: left as they are. The household's code is kept
// too, so phones paired with it stay paired.
let accessCode = "";
if (fs.existsSync(target)) {
  const DATA = ["db.json", "db.json.tmp", "media"];
  const unexpected = fs.readdirSync(target).filter((name) => ![...DATA, "dev"].includes(name));
  if (unexpected.length) {
    console.error(`Refusing to replace ${target}: it holds other files (${unexpected.slice(0, 3).join(", ")}).`);
    process.exit(1);
  }
  try {
    accessCode = JSON.parse(fs.readFileSync(path.join(target, "db.json"), "utf8")).accessCode ?? "";
  } catch {}
  for (const name of DATA) fs.rmSync(path.join(target, name), { recursive: true, force: true });
}
if (accessCode) {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "db.json"), JSON.stringify({ accessCode }));
}

const { createApp } = await import("../src/app.js");
const { createStore } = await import("../src/store.js");
const { cloudinaryEnabled, laneClip } = await import("../src/cloudinary.js");
const store = createStore(target);
const app = createApp({ store });
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, body) {
  const json = body !== undefined && !(body instanceof FormData);
  const response = await fetch(base + url, {
    method,
    headers: json ? { "content-type": "application/json" } : {},
    body: json ? JSON.stringify(body) : body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const form = (fields) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const one of [value].flat()) data.append(key, one);
  return data;
};

try {
  // ---- The family ------------------------------------------------------------------------------
  // Maya arrives first, so she looks after the settings.
  const maya = await call("POST", "/api/members", { name: "Maya", relationship: "Daughter" });
  const jake = await call("POST", "/api/members", { name: "Jake", relationship: "Son" });
  await call("PUT", "/api/profile", { wearerName: "Grandma", carerName: "Maya", changedBy: maya.id });
  await call("PUT", "/api/profile", { consent: { wearerAgreed: true, agreedBy: "Grandma" }, changedBy: maya.id });
  await call("PUT", "/api/profile", { consent: { careSignals: true }, changedBy: maya.id });

  // Maya's hello: what is heard, and seen, when the wearer asks who she is. The words are the
  // ones she says in the recording.
  const mayaWords = "I'm your daughter, Mom. You took care of me every single day. When I was little, you used to hold my hand and walk me to school.";
  await call(
    "POST",
    `/api/members/${maya.id}/profile`,
    form({ introText: mayaWords, introAudio: file("mayaHello"), introVideo: file("mayaHelloVideo"), photo: file("mayaPhoto") }),
  );
  await call("POST", `/api/members/${jake.id}/profile`, form({ photo: file("jakePhoto") }));
  // Jake has recorded no hello yet. Until he does, the glasses say "This is Jake, your son."

  // Jake's memory lane: the thirteen clips of lane/memories.js, uploaded to Cloudinary once by
  // seed-lane.mjs. They are linked again rather than uploaded, since the server only takes a
  // lane clip as an upload; so this one part is written to the store directly.
  if (cloudinaryEnabled()) {
    const at = Date.now();
    store.members.find((m) => m.id === jake.id).lane = JAKE_LANE.map(([year, title, publicId], i) => ({
      id: store.newId("l"),
      year,
      title,
      ...laneClip(publicId),
      addedAt: new Date(at + i * 1000).toISOString(),
    }));
    store.save();
  } else {
    console.warn("CLOUDINARY_URL is not set, so Jake's memory lane (kept on Cloudinary) is left out.");
  }

  // ---- The memories ----------------------------------------------------------------------------
  const keychain = await call(
    "POST",
    "/api/keepsakes",
    form({
      name: "Elephant keychain",
      description: "A round keyring on a short chain: a dark carved elephant set in a pale ring.",
      from: "Maya",
      story: "Hi Mom, it's Maya. That's the keychain from Sri Lanka. We went together in 2020 and swam in the sea for hours and hours.",
      consentConfirmed: "true",
      addedBy: maya.id,
      people: maya.id,
      referencePhotos: file("keychainPhoto"),
      voiceNote: file("keychainVoice"),
      clip: file("keychainVideo"),
    }),
  );
  const graduation = await call(
    "POST",
    "/api/keepsakes",
    form({
      name: "Graduation photo",
      description: "A photograph of a woman in a floral dress hugging a young man in a black graduation gown and cap, who is holding a rolled certificate, outside a stone university building.",
      from: "Jake",
      story: "Hi Mom, it's Jake. This is the day I graduated. She was so happy. I remember Maya lost her jacket that day, and we ran around campus like headless chickens for an hour.",
      consentConfirmed: "true",
      addedBy: jake.id,
      people: jake.id,
      referencePhotos: file("graduationPhoto"),
      voiceNote: file("graduationVoice"),
      clip: file("graduationVideo"),
    }),
  );

  // The first person named in a memory is who "who is that?" answers with. The fox, Christmas
  // and birthday videos have Maya and Jake in them (as children at Christmas); the dog walk
  // has only Grandma and Fluffy.
  const garden = await call(
    "POST",
    "/api/keepsakes",
    form({
      name: "Garden lantern",
      description: "A white plastic lantern candle, a tall cylinder with a gold metal lid pierced with round holes.",
      from: "Jake",
      story: "Do you remember when we decorated the garden and there was a fox out front? We were so scared.",
      consentConfirmed: "true",
      addedBy: jake.id,
      people: `${jake.id},${maya.id}`,
      referencePhotos: file("gardenPhotos"),
      voiceNote: file("gardenVoice"),
      clip: file("gardenVideo"),
    }),
  );
  const christmas = await call(
    "POST",
    "/api/keepsakes",
    form({
      name: "Snowman chocolate box",
      description: "A flat box of Christmas chocolates with three snowmen in knitted hats in front of a glowing Christmas tree, and a small oval Chocoland label.",
      from: "Maya",
      story: "I remember how we all gathered round to open presents with hot chocolate and marshmallows.",
      consentConfirmed: "true",
      addedBy: maya.id,
      people: `${maya.id},${jake.id}`,
      referencePhotos: file("christmasPhotos"),
      voiceNote: file("christmasVoice"),
      clip: file("christmasVideo"),
    }),
  );
  const birthday = await call(
    "POST",
    "/api/keepsakes",
    form({
      name: "50th birthday card",
      description: "A tall birthday card with a large pink rose and a red \"50\" at the top.",
      from: "Maya",
      story: "I remember your 50th birthday, when we surprised you and you screamed so loud.",
      consentConfirmed: "true",
      addedBy: maya.id,
      people: `${maya.id},${jake.id}`,
      referencePhotos: file("birthdayPhotos"),
      voiceNote: file("birthdayVoice"),
      clip: file("birthdayVideo"),
    }),
  );
  const dog = await call(
    "POST",
    "/api/keepsakes",
    form({
      name: "Fluffy's card",
      description: "A card with a photograph of a basset hound's face, long brown ears and sad eyes, on a bright blue background.",
      from: "Jake",
      story: "Do you remember going on walks with Fluffy? He loves you so much, and he misses you.",
      consentConfirmed: "true",
      addedBy: jake.id,
      referencePhotos: file("dogPhotos"),
      voiceNote: file("dogVoice"),
      clip: file("dogVideo"),
    }),
  );

  // "Who's Maya?" asked in so many words, with no photo of her in view: her own recording.
  for (const question of ["Who's Maya?", "Who is Maya?"]) {
    await call("POST", "/api/questions", form({ question, text: mayaWords, speaker: "Maya", addedBy: maya.id, audio: file("mayaHello") }));
  }

  // ---- A fortnight of use ----------------------------------------------------------------------
  // Maya's hello is still being made on Cloudinary, which signs with the time: wait for it
  // before the clock is wound back.
  while (app.locals.films.helloState(maya).making) await new Promise((resolve) => setTimeout(resolve, 1000));
  const memories = { keychain, graduation, garden, christmas, birthday, dog };
  const used = await useForAFortnight(memories, { maya, jake });

  console.log(`Demo household written to ${target}`);
  console.log(`  Family: ${store.members.map((m) => `${m.name} (${m.relationship})`).join(", ")}; the glasses are worn by ${store.profile.wearerName}`);
  for (const member of store.members) if (member.lane?.length) console.log(`  Memory lane: ${member.name}, ${member.lane.length} clips`);
  for (const memory of [keychain, graduation, garden, christmas, birthday, dog]) {
    console.log(`  Memory: ${memory.name}, from ${memory.from}. Lane: ${memory.lane ? memory.lane.note || "planned" : "none"}`);
  }
  console.log(`  A fortnight of use: ${used.events} things the glasses did, ${used.open} questions waiting, ${store.notifications.length} notifications`);
  console.log("Run the server on it with: npm run start:recordings");
  console.log("Then open each memory in the family app and press “Put it on the glasses”, so the glasses have its film.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  server.close();
}

/**
 * Two weeks of the glasses being worn, made up, through the server's own endpoints with its
 * clock wound back: looks at each memory (the look is told which one is in view, so no model is
 * called), replays, questions, a relative asking another for an answer, and the evenings the
 * glasses came off. What was set up above is moved back to a fortnight ago first.
 */
async function useForAFortnight(memories, people) {
  process.env.ML_RECOGNISER = "rehearsal";
  const RealDate = Date;
  const realNow = RealDate.now();
  const today = new RealDate(realNow);
  const on = (daysAgo, hh, mm = 0) => new RealDate(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hh, mm).getTime();

  // Everything set up so far happened a fortnight ago, a little after six in the evening.
  const shift = realNow - on(14, 18, 5);
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
  const backdate = (value) => {
    if (typeof value === "string") return ISO.test(value) ? new RealDate(RealDate.parse(value) - shift).toISOString() : value;
    if (value && typeof value === "object") for (const key of Object.keys(value)) value[key] = backdate(value[key]);
    return value;
  };
  for (const part of [store.profile, store.members, store.keepsakes, store.bank, store.notifications, store.consentLog, store.events]) backdate(part);
  store.save();

  let simulated = realNow;
  globalThis.Date = class extends RealDate {
    constructor(...parts) {
      super(...(parts.length ? parts : [simulated]));
    }
    static now() {
      return simulated;
    }
  };

  let seed = 20261114;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];

  // Seeding runs in rehearsal mode, where the hint names the memory and the picture is not
  // looked at. Each look still sends the memory's own photo, as the glasses would.
  const PHOTO_OF = { keychain: "keychainPhoto", graduation: "graduationPhoto", garden: "gardenPhotos", christmas: "christmasPhotos", birthday: "birthdayPhotos", dog: "dogPhotos" };
  const frames = Object.fromEntries(Object.entries(PHOTO_OF).map(([key, files]) => [key, fs.readFileSync(path.join(source, [FILES[files]].flat()[0])).toString("base64")]));
  const look = (key) => () => call("POST", "/api/recognise", { image: frames[key], hint: memories[key].id });
  const ask = (question, key) => () => call("POST", "/api/ask", { question, keepsakeId: key ? memories[key].id : undefined });
  const happened = (type, key) => () => call("POST", "/api/events", { events: [{ type, keepsakeId: key ? memories[key].id : undefined }] });

  // What is asked with each memory open. None has a recorded answer yet, so they wait for one.
  const questionsFor = {
    keychain: ["When did we go to Sri Lanka?", "Who gave me this?"],
    graduation: ["What did Jake study?", "Where was this?"],
    garden: ["Where is the lantern now?"],
    christmas: ["Who gave me these chocolates?"],
    birthday: ["Who came to my party?"],
    dog: ["Where is Fluffy?", "Is Fluffy all right?"],
  };
  // How much each is looked at: the newer and the more loved, the more often.
  const weight = { keychain: 3, graduation: 3, garden: 2, christmas: 2, birthday: 2, dog: 3 };
  const often = Object.entries(weight).flatMap(([key, n]) => Array(n).fill(key));
  // "Who's Maya?" has Maya's own answer; the others are new to the family.
  const everyday = ["Who's Maya?", "Who's Maya?", "Who is Maya?", "Where is Jake?", "What day is it?"];

  const timeline = [];
  const at = (time, run) => timeline.push({ time, run });
  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const looks = 3 + Math.floor(random() * 4);
    for (let i = 0; i < looks; i++) {
      const key = pick(often);
      const time = on(daysAgo, 9 + Math.floor(random() * 11), Math.floor(random() * 60));
      at(time, look(key));
      if (random() < 0.5) at(time + 40_000, ask(pick(questionsFor[key]), key));
      if (random() < 0.35) at(time + 90_000, happened("memory_replayed", key));
    }
    const asks = 1 + Math.floor(random() * 3);
    for (let i = 0; i < asks; i++) at(on(daysAgo, 8 + Math.floor(random() * 13), Math.floor(random() * 60)), ask(pick(everyday)));
    if (daysAgo > 0) at(on(daysAgo, 21, 30 + Math.floor(random() * 20)), happened("glasses_removed"));
  }
  at(on(6, 10, 15), happened("browse_opened"));
  at(on(5, 9, 5), ask("Is it bin day?"));
  at(on(4, 11, 0), () => call("POST", "/api/notifications/request", { forMember: people.jake.id, fromMember: people.maya.id, keepsakeId: memories.dog.id, question: "Where is Fluffy?" }));
  at(on(2, 17, 40), happened("low_battery"));
  at(on(1, 15, 12), happened("privacy_pause"));
  at(on(1, 15, 40), happened("privacy_resume"));
  at(realNow - 4 * 60 * 60 * 1000, ask("Is it bin day?"));
  for (const minutesAgo of [58, 49, 41]) at(realNow - minutesAgo * 60 * 1000, ask("Where is Jake?"));

  try {
    for (const step of timeline.filter((s) => s.time <= realNow - 60 * 1000).sort((a, b) => a.time - b.time)) {
      simulated = step.time;
      await step.run();
    }
  } finally {
    simulated = realNow;
    globalThis.Date = RealDate;
  }
  const byTime = (a, b) => String(a.at).localeCompare(String(b.at));
  store.events.sort(byTime);
  store.notifications.sort(byTime);
  store.save();

  // Everyone has read what is more than two days old, so the bell shows only recent news.
  const cutoff = realNow - 2 * 24 * 60 * 60 * 1000;
  for (const member of store.members) {
    const { notifications } = await call("GET", `/api/notifications?member=${member.id}`);
    const old = notifications.filter((n) => Date.parse(n.at) < cutoff).map((n) => n.id);
    if (old.length) await call("POST", "/api/notifications/read", { member: member.id, ids: old });
  }
  const { open } = await call("GET", "/api/questions");
  return { events: store.events.length, open: open.length };
}
