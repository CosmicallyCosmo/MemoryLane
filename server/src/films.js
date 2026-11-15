// Makes the glasses copies with Cloudinary, in the background, so nobody has to keep a page
// open while one records. A memory's tunnel and a person's hello each get: a silent video for
// the display, served from Cloudinary, and its sound, kept here because the phone plays it
// (and keeps a copy for when there is no connection).
//
// The originals are uploaded once and remembered (`cloud` on the memory or the person). What
// the glasses play is an address made from them; see cloudinary.js.
import fs from "node:fs";
import path from "node:path";
import {
  clipUrl,
  cloudinaryEnabled,
  destroyAsset,
  ensureBlank,
  filmSeconds,
  filmUrl,
  helloClipUrl,
  posterUrl,
  uploadAsset,
  whenReady,
} from "./cloudinary.js";

// The display would not show more, and an address has a length limit.
const MAX_SHOTS = 24;

export function createFilmMaker({ store }) {
  /** What is being made now, or went wrong last time. Not kept across restarts. */
  const jobs = new Map();
  // One at a time: uploads are large and a household has few memories.
  let queue = Promise.resolve();

  const state = (key) => {
    const job = jobs.get(key);
    return { making: job?.state === "making", error: job?.state === "failed" ? job.error : null };
  };

  async function asset(owner, file) {
    owner.cloud ??= {};
    if (owner.cloud[file]) return owner.cloud[file];
    const made = await uploadAsset(path.join(store.mediaDir, path.basename(file)));
    owner.cloud[file] = made;
    store.save();
    return made;
  }

  /** The sound of a glasses copy: its own file, so removing the copy never removes the original. */
  function soundCopy(file) {
    if (!file) return null;
    const from = path.join(store.mediaDir, path.basename(file));
    if (!fs.existsSync(from)) return null;
    const name = `${store.newId("m")}${path.extname(file).toLowerCase()}`;
    fs.copyFileSync(from, path.join(store.mediaDir, name));
    return name;
  }

  function start(key, work) {
    if (!cloudinaryEnabled()) return false;
    const job = { state: "making", error: null };
    jobs.set(key, job);
    queue = queue
      .then(work)
      .then(
        () => jobs.get(key) === job && jobs.delete(key),
        (error) => {
          console.warn(`glasses copy ${key}:`, error?.message ?? error);
          if (jobs.get(key) === job) jobs.set(key, { state: "failed", error: "Cloudinary could not make the glasses copy. It will be tried again when the memory changes." });
        },
      );
    return true;
  }

  async function makeTunnel(id) {
    const keepsake = store.keepsake(id);
    const tunnel = keepsake?.lane;
    if (!tunnel) return;
    const version = tunnel.version;
    const own = new Set([...keepsake.memoryPhotos, keepsake.clip].filter(Boolean));
    let shots = tunnel.plan.segments
      .filter((segment) => segment.keepsakeId === keepsake.id)
      .flatMap((segment) => segment.shots)
      .filter((shot) => own.has(shot.file))
      .slice(0, MAX_SHOTS);
    if (!shots.length) return;
    if (shots.every((shot) => typeof shot.at === "number")) shots = [...shots].sort((a, b) => a.at - b.at);

    const assets = [];
    for (const shot of shots) assets.push(await asset(keepsake, shot.file));

    /** Puts a finished film on the glasses, unless the memory changed while it was made. */
    const put = (url) => {
      if (store.keepsake(id) !== keepsake || !keepsake.lane || keepsake.lane.version !== version) return false;
      // Only the picture changed: the sound already kept for this version stays.
      const same = tunnel.lens?.by === "cloudinary" && tunnel.lens.version === version;
      const audio = same ? tunnel.lens.audio : soundCopy(keepsake.voiceNote);
      if (tunnel.lens && !same) {
        store.removeMedia(tunnel.lens.video);
        store.removeMedia(tunnel.lens.audio);
      }
      tunnel.lens = { video: url, audio, version, madeAt: new Date().toISOString(), by: "cloudinary" };
      keepsake.poster = posterUrl(assets.find((a) => a.type === "video") ?? assets[0]);
      store.save();
      return true;
    };

    // A memory that is one video: the clip itself, cropped, resized and silent. The middle of
    // the picture at once, then cropped around its subject when Cloudinary has watched it.
    if (assets.length === 1 && assets[0].type === "video") {
      const plain = clipUrl(assets[0]);
      if (!(await whenReady(plain))) throw new Error("the film was not ready in time");
      if (!put(plain)) return store.keepsake(id) === keepsake && keepsake.lane ? makeTunnel(id) : undefined;
      const smart = clipUrl(assets[0], { smart: "subject" });
      if ((await whenReady(smart)) && tunnel.lens?.video === plain) put(smart);
      return;
    }

    const base = await ensureBlank();
    const voice = keepsake.voiceNote ? await asset(keepsake, keepsake.voiceNote) : null;
    const seconds = filmSeconds(
      shots.map((shot, i) => ({ at: shot.at, type: assets[i].type, duration: assets[i].duration })),
      voice?.duration ?? null,
      tunnel.plan.pace,
    );
    const url = filmUrl(
      shots.map((shot, i) => ({ ...assets[i], seconds: seconds[i], focus: shot.focus, motion: shot.motion })),
      base,
    );
    if (!(await whenReady(url))) throw new Error("the film was not ready in time");

    // The memory may have been changed or removed while the film was being made.
    if (!put(url) && store.keepsake(id) === keepsake && keepsake.lane) return makeTunnel(id);
  }

  async function makeHello(id) {
    const member = store.members.find((m) => m.id === id);
    if (!member?.introVideo || !member.introAudio) return;
    const video = member.introVideo;
    const sound = member.introAudio;
    const still = () => store.members.includes(member) && member.introVideo === video && member.introAudio === sound;
    const clip = await asset(member, video);

    // Straight away: the middle of the picture. Then, once Cloudinary has found the faces in
    // it (which takes it a little while the first time), the same clip cropped around them.
    const plain = helloClipUrl(clip);
    if (!(await whenReady(plain))) throw new Error("the hello was not ready in time");
    if (!still()) return;
    if (member.introLens) {
      store.removeMedia(member.introLens.video);
      store.removeMedia(member.introLens.audio);
    }
    member.introLens = { video: plain, audio: soundCopy(sound), by: "cloudinary" };
    member.introPoster = posterUrl(clip, { width: 480, height: 480 });
    store.save();

    const smart = helloClipUrl(clip, { smart: true });
    if ((await whenReady(smart)) && still() && member.introLens?.video === plain) {
      member.introLens.video = smart;
      store.save();
    }
  }

  return {
    enabled: cloudinaryEnabled,
    tunnelState: (keepsake) => state(`tunnel:${keepsake.id}`),
    helloState: (member) => state(`hello:${member.id}`),

    /** Makes, or makes again, the glasses copy of a memory's tunnel. False if Cloudinary is not set up. */
    tunnel: (keepsake) => Boolean(keepsake?.lane) && start(`tunnel:${keepsake.id}`, () => makeTunnel(keepsake.id)),

    /** Makes the glasses copy of a person's hello, if they have both a video and a recording. */
    hello: (member) => Boolean(member?.introVideo && member.introAudio) && start(`hello:${member.id}`, () => makeHello(member.id)),

    /** After a restart or when Cloudinary is first set up: whatever has no up-to-date copy. */
    catchUp() {
      if (!cloudinaryEnabled()) return 0;
      let started = 0;
      for (const keepsake of store.keepsakes) {
        const tunnel = keepsake.lane;
        if (tunnel && (!tunnel.lens || tunnel.lens.version !== tunnel.version) && this.tunnel(keepsake)) started++;
      }
      for (const member of store.members) {
        if (!member.introLens && this.hello(member)) started++;
      }
      return started;
    },

    /** Takes a memory's or a person's originals off Cloudinary. Call when they are removed. */
    forget(owner, files = null) {
      const cloud = owner?.cloud;
      if (!cloud) return;
      for (const file of files ?? Object.keys(cloud)) {
        if (!cloud[file]) continue;
        destroyAsset(cloud[file]);
        delete cloud[file];
      }
    },

    /** Resolves when nothing is being made. For tests. */
    idle: () => queue,
  };
}
