// A small JSON-file store. One family, one wearer: enough for a pilot household and easy to
// inspect or delete by hand. Camera frames are never written here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_PROFILE = {
  wearerName: "",
  carerName: "",
  consent: {
    // Recorded by the family app when the wearer (or the person who holds their legal
    // authority) agrees. The glasses app refuses to start looking until this is true.
    wearerAgreed: false,
    agreedBy: "",
    agreedAt: null,
    // Each signal is a separate choice, off until someone turns it on.
    logUnknownObjects: false,
    careSignals: false,
    // Heart rate while a memory is open. Health data, so it has its own switch.
    heartRate: false,
  },
};

// No 0/O or 1/I: the code is read off a screen and typed on a phone.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newAccessCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export function createStore(dataDir) {
  const mediaDir = path.join(dataDir, "media");
  const dbFile = path.join(dataDir, "db.json");
  fs.mkdirSync(mediaDir, { recursive: true });

  let db = {
    profile: structuredClone(DEFAULT_PROFILE),
    keepsakes: [],
    events: [],
    accessCode: "",
    members: [],
    notifications: [],
    // Answers to everyday questions that are not about any one object.
    bank: [],
    // Every change to what has been agreed: who changed what, and when.
    consentLog: [],
  };
  // Lens copies of the films (`tunnels`) an older version made from several memories. A memory
  // lane now belongs to one memory (keepsake.lane, see lane.js); the old ones are dropped.
  let retiredLens = [];
  if (fs.existsSync(dbFile)) {
    const loaded = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    // People are no longer recognised by their face. Drop what an older version stored for it,
    // and the history of agreeing to it, so nothing suggests it is still possible.
    delete loaded.profile?.consent?.recognisePeople;
    for (const member of loaded.members ?? []) {
      delete member.recognitionConsent;
      delete member.recognitionConsentAt;
    }
    // Memory lanes were called memory tunnels, and kept under keepsake.tunnel.
    for (const keepsake of loaded.keepsakes ?? []) {
      if ("tunnel" in keepsake) {
        keepsake.lane ??= keepsake.tunnel;
        delete keepsake.tunnel;
      }
    }
    const FACES = new Set(["recognisePeople", "recognitionConsent"]);
    if (Array.isArray(loaded.consentLog)) loaded.consentLog = loaded.consentLog.filter((entry) => !FACES.has(entry.what));
    db = {
      profile: {
        ...DEFAULT_PROFILE,
        ...loaded.profile,
        consent: { ...DEFAULT_PROFILE.consent, ...loaded.profile?.consent },
      },
      keepsakes: loaded.keepsakes ?? [],
      events: loaded.events ?? [],
      accessCode: typeof loaded.accessCode === "string" ? loaded.accessCode : "",
      members: loaded.members ?? [],
      notifications: loaded.notifications ?? [],
      bank: loaded.bank ?? [],
      consentLog: loaded.consentLog ?? [],
    };
    retiredLens = (loaded.tunnels ?? []).flatMap((t) => [t.lens?.video, t.lens?.audio]);
  }

  function save() {
    const tmp = dbFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbFile);
  }

  function removeMedia(file) {
    if (!file || file.startsWith("http")) return;
    fs.rmSync(path.join(mediaDir, path.basename(file)), { force: true });
  }

  if (!db.accessCode || retiredLens.length) {
    db.accessCode ||= newAccessCode();
    retiredLens.forEach(removeMedia);
    save();
  }

  return {
    mediaDir,
    newId: (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`,

    /** The household code a phone or another computer must present. */
    get accessCode() {
      return db.accessCode;
    },
    rotateAccessCode() {
      db.accessCode = newAccessCode();
      save();
      return db.accessCode;
    },

    get profile() {
      return db.profile;
    },
    setProfile(patch) {
      db.profile = {
        ...db.profile,
        ...patch,
        consent: { ...db.profile.consent, ...patch.consent },
      };
      save();
      return db.profile;
    },

    get keepsakes() {
      return db.keepsakes;
    },
    keepsake: (id) => db.keepsakes.find((k) => k.id === id),
    addKeepsake(keepsake) {
      db.keepsakes.push(keepsake);
      save();
      return keepsake;
    },
    deleteKeepsake(id) {
      const keepsake = db.keepsakes.find((k) => k.id === id);
      if (!keepsake) return false;
      for (const file of [
        ...keepsake.referencePhotos,
        ...keepsake.memoryPhotos,
        keepsake.voiceNote,
        keepsake.clip,
        keepsake.clipDisplay,
        keepsake.lane?.lens?.video,
        keepsake.lane?.lens?.audio,
        ...keepsake.answers.map((a) => a.audio),
      ]) {
        removeMedia(file);
      }
      db.keepsakes = db.keepsakes.filter((k) => k.id !== id);
      save();
      return true;
    },
    addAnswer(keepsakeId, answer) {
      const keepsake = db.keepsakes.find((k) => k.id === keepsakeId);
      if (!keepsake) return null;
      keepsake.answers.push(answer);
      save();
      return answer;
    },
    deleteAnswer(keepsakeId, answerId) {
      const keepsake = db.keepsakes.find((k) => k.id === keepsakeId);
      const answer = keepsake?.answers.find((a) => a.id === answerId);
      if (!answer) return false;
      removeMedia(answer.audio);
      keepsake.answers = keepsake.answers.filter((a) => a.id !== answerId);
      save();
      return true;
    },

    /** Family members who contribute, and the notices shown to them. Mutate, then save(). */
    get members() {
      return db.members;
    },
    set members(value) {
      db.members = value;
    },
    get notifications() {
      return db.notifications;
    },
    set notifications(value) {
      db.notifications = value;
    },
    get bank() {
      return db.bank;
    },
    set bank(value) {
      db.bank = value;
    },
    get consentLog() {
      return db.consentLog;
    },
    /** Records changes to consent. Each entry: { what, on, by, member? }. */
    logConsent(entries) {
      if (!entries.length) return;
      const at = new Date().toISOString();
      db.consentLog.push(...entries.map((entry) => ({ at, ...entry })));
      if (db.consentLog.length > 500) db.consentLog = db.consentLog.slice(-500);
      save();
    },
    removeMedia,
    save,
    updateKeepsake(id, patch) {
      const keepsake = db.keepsakes.find((k) => k.id === id);
      if (!keepsake) return null;
      Object.assign(keepsake, patch);
      save();
      return keepsake;
    },

    get events() {
      return db.events;
    },
    addEvent(event) {
      // A caller may pass its own time; an absent one must not blank out ours.
      const stored = { ...event, at: event.at ?? new Date().toISOString() };
      db.events.push(stored);
      // A pilot household produces a few dozen events a day; keep a rolling window.
      if (db.events.length > 5000) db.events = db.events.slice(-5000);
      save();
      return stored;
    },
    clearEvents() {
      db.events = [];
      save();
    },
    /** Removes the events of one type, for when the family withdraws what allowed them. */
    removeEventsOfType(type) {
      db.events = db.events.filter((event) => event.type !== type);
      save();
    },

    // Changes whenever anything the glasses cache changes, so the phone can skip re-downloading.
    packVersion() {
      const hash = crypto.createHash("sha1");
      hash.update(JSON.stringify([db.profile, db.keepsakes, db.members, db.bank]));
      return hash.digest("hex").slice(0, 12);
    },
  };
}
