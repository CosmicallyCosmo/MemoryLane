// Optional. The glasses fetch display video themselves, by URL, and real glasses are expected to
// need a public https address. When CLOUDINARY_URL is set, a memory lane's glasses copy is
// uploaded once and served through a transformation URL that also keeps it within the display's
// limits (MP4, at most 400px a side and 70,000 pixels in total). Without it, the glasses are
// given the server's own address.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The size the family app records the glasses copy at (family/src/lane/lens.js):
// 264 x 264 = 69,696 pixels, square to fill the 600x600 display.
export const LENS = { width: 264, height: 264 };
const SIZE = `h_${LENS.height},w_${LENS.width}`;
const SILENT_MP4 = "ac_none,vc_h264,q_auto";
// A lane clip's glasses copy is stretched from 264 to the display's 600 pixels, which makes
// any blockiness from compression plain to see: kept at the best quality, it stays smooth.
const DISPLAY_TRANSFORM = "c_fill,w_264,h_264,q_auto:best,vc_h264,ac_none";
const PAGE_TRANSFORM = "c_limit,w_1280,h_720,q_auto,vc_h264,ac_none";

const FOLDER = "memorylane";
const IMAGE_TYPES = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif", ".bmp"]);
// A second and a half of black for the first picture to fade in from.
const BLANK_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sample/blank.mp4");
const BLANK_ID = `${FOLDER}/blank`;

function config() {
  const url = process.env.CLOUDINARY_URL;
  if (!url) return null;
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url);
  return match ? { apiKey: match[1], apiSecret: match[2], cloud: match[3] } : null;
}

export const cloudinaryEnabled = () => config() !== null;

/** Signs and posts to the upload API. `params` are the signed ones; `file` goes with them. */
async function call(cfg, resourceType, action, params, file) {
  const signed = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const toSign = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join("&");
  const form = new FormData();
  if (file) form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
  for (const [key, value] of Object.entries(signed)) form.append(key, String(value));
  form.append("api_key", cfg.apiKey);
  form.append("signature", crypto.createHash("sha1").update(toSign + cfg.apiSecret).digest("hex"));
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloud}/${resourceType}/${action}`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(`Cloudinary ${action} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Uploads a clip and returns a display-ready MP4 URL, or null if Cloudinary is not set up. */
export async function uploadDisplayClip(filePath) {
  const cfg = config();
  if (!cfg) return null;
  const { public_id } = await call(cfg, "video", "upload", { folder: FOLDER }, filePath);
  return `https://res.cloudinary.com/${cfg.cloud}/video/upload/${DISPLAY_TRANSFORM}/${public_id}.mp4`;
}

export const assetType = (file) => (IMAGE_TYPES.has(path.extname(file).toLowerCase()) ? "image" : "video");

/**
 * Uploads one of the family's files as it is. Returns what later URLs need: its id, whether it
 * is an image or a video (sound counts as video), its size and, for video and sound, its length.
 */
export async function uploadAsset(filePath) {
  const cfg = config();
  if (!cfg) return null;
  const type = assetType(filePath);
  const made = await call(cfg, type, "upload", { folder: FOLDER }, filePath);
  return {
    id: made.public_id,
    type,
    width: made.width ?? null,
    height: made.height ?? null,
    duration: typeof made.duration === "number" ? made.duration : null,
  };
}

/** Removes an uploaded original, and every copy made from it. Never throws. */
export async function destroyAsset(asset) {
  const cfg = config();
  if (!cfg || !asset?.id) return false;
  try {
    await call(cfg, asset.type === "image" ? "image" : "video", "destroy", { invalidate: true, public_id: asset.id });
    return true;
  } catch (error) {
    console.warn(String(error));
    return false;
  }
}

let blank = null;
/** The black opening every tunnel fades in from. Uploaded once; later calls find it there. */
export function ensureBlank() {
  const cfg = config();
  if (!cfg) return Promise.resolve(null);
  const key = cfg.cloud;
  if (blank?.key !== key) {
    const promise = call(cfg, "video", "upload", { overwrite: false, public_id: BLANK_ID }, BLANK_FILE).then(
      () => BLANK_ID,
      (error) => {
        blank = null;
        throw error;
      },
    );
    blank = { key, promise };
  }
  return blank.promise;
}

// ---- URLs. Pure: the same plan always gives the same address, so a film is made once. -------

const delivery = (type) => `https://res.cloudinary.com/${config().cloud}/${type}/upload`;
const round = (n, places = 2) => String(Math.round(n * 10 ** places) / 10 ** places);
// In a layer, a public id's folders are separated by colons.
const layerId = (id) => id.replaceAll("/", ":");

/**
 * One video for the display: silent, the display's size. `smart` crops around what matters in
 * it, which Cloudinary works out by watching the whole clip: "faces" for a hello, "subject"
 * for a memory. Without it, the middle of the picture.
 */
export function clipUrl(asset, { smart = null } = {}) {
  const gravity = smart === "faces" ? ",g_auto:faces" : smart === "subject" ? ",g_auto" : "";
  return `${delivery("video")}/c_fill${gravity},${SIZE}/${SILENT_MP4}/${asset.id}.mp4`;
}
export const helloClipUrl = (asset, { smart = false } = {}) => clipUrl(asset, { smart: smart ? "faces" : null });

/** The picture for a tile: a frame Cloudinary chooses from a video, or a photo, cropped around what matters. */
export function posterUrl(asset, { width = 640, height = 480 } = {}) {
  const crop = `c_fill,g_auto,h_${height},w_${width}/f_auto,q_auto`;
  return asset.type === "image"
    ? `${delivery("image")}/${crop}/${asset.id}.jpg`
    : `${delivery("video")}/so_auto/${crop}/${asset.id}.jpg`;
}

/** The largest display-shaped part of a photo with the subject as near its middle as it can be. */
export function cropAround({ width, height }, [fx, fy]) {
  const shape = LENS.width / LENS.height;
  let w = width;
  let h = Math.round(width / shape);
  if (h > height) {
    h = height;
    w = Math.round(height * shape);
  }
  const x = Math.round(Math.min(width - w, Math.max(0, fx * width - w / 2)));
  const y = Math.round(Math.min(height - h, Math.max(0, fy * height - h / 2)));
  return { x, y, w, h };
}

// The fades are slow. Each one overlaps the pictures either side of it, so a picture is given
// that much longer than the time it should be seen for.
export const FADE_SECONDS = 1.5;
const OPENING_SECONDS = 1.6;
const SPLICE = `fl_splice:transition_(name_fade;du_${FADE_SECONDS})`;
const MAX_PUSH_IN_SECONDS = 40;

/** How far in a slow move has to start for the subject to be in the middle of the display. */
function startZoom({ width, height }, [fx, fy]) {
  const shape = LENS.width / LENS.height;
  const wider = width / height >= shape;
  // The subject may sit a little off the middle of what is shown.
  const slackX = 0.3 * (wider ? (shape * height) / width : 1);
  const slackY = 0.3 * (wider ? 1 : width / shape / height);
  const off = Math.max(0, Math.abs(fx - 0.5) - slackX / 2, Math.abs(fy - 0.5) - slackY / 2);
  return 1 / (1 - 2 * off);
}

function photoLayer(shot, last) {
  const focus = shot.focus ?? [0.5, 0.45];
  const seconds = round(shot.seconds, 1);
  const zoom = startZoom(shot, focus);
  // A slow move towards the subject, on the last picture only: Cloudinary drops what came
  // before a moving picture when another fades in after it.
  if (last && shot.motion !== "still" && zoom <= 1.4 && shot.seconds <= MAX_PUSH_IN_SECONDS) {
    const at = `x_${round(focus[0])};y_${round(focus[1])}`;
    return [
      `${SPLICE},l_${layerId(shot.id)}`,
      `e_zoompan:du_${seconds};fps_25;from_(zoom_${round(zoom)};${at});to_(zoom_${round(zoom + 0.18)};${at})`,
      `c_fill,${SIZE}`,
      "fl_layer_apply",
    ];
  }
  const { x, y, w, h } = cropAround(shot, focus);
  return [`${SPLICE},l_${layerId(shot.id)}`, `du_${seconds}`, `c_crop,h_${h},w_${w},x_${x},y_${y}`, `c_scale,${SIZE}`, "fl_layer_apply"];
}

const videoLayer = (shot) => [`${SPLICE},l_video:${layerId(shot.id)}`, `du_${round(shot.seconds, 1)}`, `c_fill,${SIZE}`, "fl_layer_apply"];

/**
 * A memory tunnel for the display, as one address: a black opening, then each photo and video
 * fading into the next. `shots`: { id, type, width, height, seconds, focus, motion }, with
 * `seconds` already including the fade (see filmSeconds).
 */
export function filmUrl(shots, base = BLANK_ID) {
  const layers = shots.flatMap((shot, i) => (shot.type === "image" ? photoLayer(shot, i === shots.length - 1) : videoLayer(shot)));
  return [delivery("video"), `du_${OPENING_SECONDS}`, `c_fill,${SIZE}`, ...layers, SILENT_MP4, `${base}.mp4`].join("/");
}

/**
 * How long each shot is shown for, following the plan: a shot starts at its `at` (seconds into
 * the voice message) and runs to the next. With no times, they share the voice message evenly.
 * `shots`: { at, type, duration }. Returns seconds for filmUrl, fades included.
 */
export function filmSeconds(shots, voiceSeconds, pace = "gentle") {
  const each = pace === "slower" ? 9 : 7;
  const least = 4;
  const total = Math.max(voiceSeconds ?? 0, shots.length * least);
  const timed = shots.every((shot) => typeof shot.at === "number");
  const starts = timed ? shots.map((shot) => shot.at) : shots.map((_, i) => (voiceSeconds ? (i * total) / shots.length : i * each));
  const end = voiceSeconds ? Math.max(total, starts.at(-1) + least) : starts.at(-1) + each;
  return shots.map((shot, i) => {
    let seen = Math.max(least, (i + 1 < shots.length ? starts[i + 1] : end) - starts[i]);
    // A video is not stretched: it plays for as long as it is, then the next picture comes.
    if (shot.type === "video" && shot.duration) seen = Math.min(seen, Math.max(least, shot.duration - FADE_SECONDS));
    return Math.round((seen + FADE_SECONDS) * 10) / 10;
  });
}

/**
 * Asks for an address until it is ready. Cloudinary makes a film the first time it is asked
 * for, and says 423 while it is still working out where the faces are. Resolves true when it
 * answers with the file; throws if it says the address is wrong.
 */
export async function whenReady(url, { tries = 40, waitMs = Number(process.env.ML_CLOUDINARY_WAIT_MS || 3000) } = {}) {
  for (let i = 0; i < tries; i++) {
    let response = null;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      await response.arrayBuffer();
    } catch {
      response = null;
    }
    if (response?.ok) return true;
    if (response && [400, 401, 404].includes(response.status)) {
      throw new Error(`Cloudinary could not make ${url}: ${response.headers.get("x-cld-error") ?? response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return false;
}

/**
 * Uploads one clip of a person's memory lane. Returns the full video (for the walk-through in a
 * browser) and the display-sized silent copy (for the glasses), or null if Cloudinary is not set
 * up. The display copy is made at upload, so the glasses never wait for it.
 */
export async function uploadLaneClip(filePath) {
  const cfg = config();
  if (!cfg) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "memorylane/lane";
  const signature = crypto
    .createHash("sha1")
    .update(`eager=${DISPLAY_TRANSFORM}&folder=${folder}&timestamp=${timestamp}${cfg.apiSecret}`)
    .digest("hex");

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", folder);
  form.append("eager", DISPLAY_TRANSFORM);
  form.append("signature", signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloud}/video/upload`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Cloudinary upload failed: ${response.status} ${await response.text()}`);
  const { public_id } = await response.json();
  return laneClip(public_id);
}

/**
 * A lane clip as the walk-through page plays it: no larger than the page draws it, and without
 * the sound the page never plays. The clip as it was uploaded is several times the size, and
 * thirteen of those at once do not arrive in time on an ordinary connection. Other addresses
 * are returned as they are.
 */
export function lanePageVideo(url) {
  return transformed(url, PAGE_TRANSFORM);
}

/**
 * A lane clip as the glasses play it: cut square to fill the display, as a memory's film is.
 * Worked out from the clip's address each time, so clips added when the display copy was
 * another shape come out right as well. Null for a clip that is not on Cloudinary.
 */
export function laneLensVideo(url) {
  const made = transformed(url, DISPLAY_TRANSFORM);
  return made === url ? null : made;
}

function transformed(url, transform) {
  const marker = "/video/upload/";
  const at = typeof url === "string" && url.startsWith("https://res.cloudinary.com/") ? url.indexOf(marker) : -1;
  if (at < 0) return url;
  return `${url.slice(0, at + marker.length)}${transform}/${url.slice(at + marker.length)}`;
}

/** A memory lane clip already on Cloudinary, by its public id: the full video and the glasses copy. Null without Cloudinary. */
export function laneClip(publicId) {
  const cfg = config();
  if (!cfg) return null;
  const base = `https://res.cloudinary.com/${cfg.cloud}/video/upload`;
  return { video: `${base}/${publicId}.mp4`, lens: `${base}/${DISPLAY_TRANSFORM}/${publicId}.mp4` };
}

/**
 * Moves glasses copies that are still served from here to Cloudinary: the ones made before
 * CLOUDINARY_URL was set. Covers memory lanes and hellos. Returns how many were moved.
 */
export async function publishLensCopies(store) {
  if (!cloudinaryEnabled()) return 0;
  const copies = [...store.keepsakes.map((k) => k.lane?.lens), ...store.members.map((m) => m.introLens)];
  let moved = 0;
  for (const lens of copies) {
    if (!lens?.video || lens.video.startsWith("http")) continue;
    const file = path.join(store.mediaDir, path.basename(lens.video));
    if (!fs.existsSync(file)) continue;
    try {
      lens.video = await uploadDisplayClip(file);
      fs.rmSync(file, { force: true });
      store.save();
      moved++;
    } catch (error) {
      console.warn(String(error));
    }
  }
  return moved;
}
