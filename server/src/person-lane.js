// A person's memory lane (the "person lane"): short clips from their life, in order of year, that the wearer walks
// through one after another. Each relative has their own (member.lane), added from their profile
// in the family app. The walk-through itself is the page in lane/memory-lane.html; the server
// keeps the list, stores the clips (on Cloudinary when it is set up, otherwise here) and serves
// the page with that person's clips in place of the sample ones.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudinaryEnabled, laneLensVideo, lanePageVideo, uploadLaneClip } from "./cloudinary.js";

const PAGE = fileURLToPath(new URL("../../lane/memory-lane.html", import.meta.url));
const MAX_CLIPS = 30;

const ordered = (member) => [...(member.lane ?? [])].sort((a, b) => a.year - b.year || a.addedAt.localeCompare(b.addedAt));

const lensOf = (clip) => laneLensVideo(clip.video) ?? clip.lens ?? null;

/** What the glasses need: how many moments, and each one's year, title and display-sized clip. */
export function personLane(member, mediaUrl) {
  const clips = ordered(member);
  if (!clips.length) return null;
  return { count: clips.length, clips: clips.map((c) => ({ year: c.year, title: c.title, lens: lensOf(c), video: mediaUrl(c.video) })) };
}

/** Removes the clips kept on this server when a person leaves. Cloudinary copies are left. */
export function removePersonLane(store, member) {
  for (const clip of member.lane ?? []) if (!clip.video.startsWith("http")) store.removeMedia(clip.video);
  member.lane = [];
}

// Added to the page as it is served. The page's videos become WebGL textures, which a browser
// only allows for another site's video (Cloudinary) when it is asked for with crossOrigin. And
// the walk starts and moves on by itself, staying a few seconds at each moment; the arrow keys
// and a tap still step. With ?auto=0 it waits to be stepped, as the phone app does, which moves
// it in time with the glasses.
// Until a clip has arrived the page paints a scene of its own in its place. That is never shown
// at the start: the picture stays dark, under the person's name, until the first clips are in.
const SHIM = `<script>
(() => {
  const make = document.createElement.bind(document);
  const videos = [];
  document.createElement = (tag, ...rest) => {
    const el = make(tag, ...rest);
    if (String(tag).toLowerCase() === "video") {
      el.crossOrigin = "anonymous";
      videos.push(el);
    }
    return el;
  };
  const auto = new URLSearchParams(location.search).get("auto") !== "0";
  const style = make("style");
  style.textContent =
    "#stage,#caption,#ticks,#hint{visibility:hidden}" +
    "body.arrived #stage,body.arrived #caption,body.arrived #ticks,body.arrived #hint{visibility:visible}" +
    (auto ? "#enter{display:none}" : "");
  document.head.appendChild(style);
  // The page's own script sets window.__lane when it is ready. "load" is not waited for: it
  // holds off until every clip has been fetched.
  const started = Date.now();
  const ready = setInterval(() => {
    const lane = window.__lane;
    if (!lane) return;
    const count = (window.MEMORY_LANE?.memories ?? []).length;
    const first = videos.slice(0, 2);
    const arrived = first.every((v) => v.readyState >= 2 && v.videoWidth);
    if (count && !arrived && Date.now() - started < 20000) return;
    clearInterval(ready);
    // The walk begins again from the dark if someone stepped in before the clips were there.
    const begun = lane.state.started;
    document.body.classList.add("arrived");
    if (!auto || !count) return;
    // A phone app from before ?auto=0 steps the page itself: from its first step it leads.
    const step = lane.step;
    lane.step = (by) => {
      lane.state.auto = false;
      step(by);
    };
    lane.state.auto = true;
    if (!begun) setTimeout(() => lane.begin(), 600);
  }, 200);
})();
</script>`;

export function registerPersonLanes(app, { store, upload, mediaUrl, requireCode, grantSession }) {
  const find = (id) => store.members.find((m) => m.id === id);
  const publicLane = (member) => ({
    id: member.id,
    name: member.name,
    cloud: cloudinaryEnabled(),
    memories: ordered(member).map((c) => ({ id: c.id, year: c.year, title: c.title, src: mediaUrl(c.video), lens: lensOf(c) })),
  });

  app.get("/api/members/:id/lane", (req, res) => {
    const member = find(req.params.id);
    if (!member) return res.status(404).json({ error: "Not found." });
    res.json(publicLane(member));
  });

  app.post("/api/members/:id/lane", upload.single("video"), async (req, res) => {
    const file = req.file;
    const fail = (status, error) => {
      if (file) store.removeMedia(file.filename);
      res.status(status).json({ error });
    };
    const member = find(req.params.id);
    if (!member) return fail(404, "Not found.");
    if (!file || !file.mimetype.startsWith("video/")) return fail(400, "Please choose a video.");
    const year = Number(req.body?.year);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 1) return fail(400, "Please add the year it was.");
    const title = String(req.body?.title ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!title) return fail(400, "Please say what the moment was.");
    if ((member.lane ?? []).length >= MAX_CLIPS) return fail(400, `A memory lane holds up to ${MAX_CLIPS} moments.`);

    // Kept in the cloud when Cloudinary is set up, so real glasses and any phone can fetch it.
    let video = file.filename;
    let lens = null;
    if (cloudinaryEnabled()) {
      try {
        ({ video, lens } = await uploadLaneClip(file.path));
        store.removeMedia(file.filename);
      } catch (error) {
        console.warn(String(error));
      }
    }
    if (!find(member.id)) return fail(404, "Not found.");
    member.lane = [...(member.lane ?? []), { id: store.newId("l"), year, title, video, lens, addedAt: new Date().toISOString() }];
    store.save();
    res.status(201).json(publicLane(member));
  });

  app.delete("/api/members/:id/lane/:clipId", (req, res) => {
    const member = find(req.params.id);
    const clip = member?.lane?.find((c) => c.id === req.params.clipId);
    if (!clip) return res.status(404).json({ error: "Not found." });
    if (!clip.video.startsWith("http")) store.removeMedia(clip.video);
    member.lane = member.lane.filter((c) => c !== clip);
    store.save();
    res.json(publicLane(member));
  });

  // The walk-through: /lane/<person id>/memory-lane.html. A phone that arrives with the household
  // code in the address is given the session cookie, so the list and any clips kept here load.
  app.use("/lane", requireCode);
  app.get("/lane/:id/memory-lane.html", (req, res) => {
    if (!find(req.params.id) || !fs.existsSync(PAGE)) return res.status(404).send("Not found.");
    grantSession(res);
    const html = fs.readFileSync(PAGE, "utf8").replace('<script src="memories.js"></script>', `${SHIM}<script src="memories.js"></script>`);
    res.set("Cache-Control", "no-store").type("html").send(html);
  });
  app.get("/lane/:id/memories.js", (req, res) => {
    const member = find(req.params.id);
    if (!member) return res.status(404).send("");
    const lane = { name: member.name.split(/\s+/)[0], memories: ordered(member).map((c) => ({ year: c.year, title: c.title, src: lanePageVideo(mediaUrl(c.video)) })) };
    res.set("Cache-Control", "no-store").type("js").send(`window.MEMORY_LANE = ${JSON.stringify(lane).replace(/</g, "\\u003c")};`);
  });

  return { publicLane };
}
