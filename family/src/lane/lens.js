// The glasses copy of a lane: played once, in real time, into a canvas the size the glasses
// display takes, and recorded. The picture becomes a silent MP4 for the display; the sound is
// recorded apart, because the phone plays it to the glasses' speakers itself (whether display
// video carries sound is not known, and glasses with no display still get the sound).
import { createLanePlayer } from "./player.js";

// The display plays MP4 up to 400px a side and 70,000 pixels in all. Even sides for H.264.
// Square, because the 600x600 display stretches video to its full width: a square film covers
// the whole lens, with the name and "From ..." at the bottom, where a wider one leaves the
// bottom of the lens empty. 264 x 264 = 69,696 pixels.
export const LENS_WIDTH = 264;
export const LENS_HEIGHT = 264;
const VIDEO_MIME = "video/mp4;codecs=avc1";
const AUDIO_TYPES = [
  { mime: "audio/webm;codecs=opus", type: "audio/webm", ext: "webm" },
  { mime: "audio/ogg;codecs=opus", type: "audio/ogg", ext: "ogg" },
  { mime: "audio/mp4", type: "audio/mp4", ext: "m4a" },
];

const audioType = () =>
  typeof MediaRecorder !== "undefined" ? AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t.mime)) : null;

export function canMakeLensCopy() {
  return (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported(VIDEO_MIME) &&
    Boolean(audioType()) &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

function recorder(stream, mimeType, options) {
  const chunks = [];
  const media = new MediaRecorder(stream, { mimeType, ...options });
  media.addEventListener("dataavailable", (event) => event.data.size && chunks.push(event.data));
  const stopped = new Promise((resolve, reject) => {
    media.addEventListener("stop", () => resolve(new Blob(chunks, { type: mimeType.split(";")[0] })), { once: true });
    media.addEventListener("error", () => reject(new Error("The recording failed.")), { once: true });
  });
  return { media, stopped };
}

/**
 * Takes as long as the lane does. Resolves with { video, audio } Files; rejects if it fails
 * or is cancelled through `signal`.
 */
export async function makeLensCopy(lane, { signal, onProgress } = {}) {
  if (!canMakeLensCopy()) throw new Error("This browser can't make the glasses copy. Try Chrome or Edge on a computer.");
  const canvas = document.createElement("canvas");
  canvas.width = LENS_WIDTH;
  canvas.height = LENS_HEIGHT;
  let finished;
  const ended = new Promise((resolve) => (finished = resolve));
  let player = null;
  player = await createLanePlayer({
    canvas,
    lane,
    record: true,
    // The first frame is drawn before the player is handed back.
    onTime: (t) => player && onProgress?.(t / player.duration),
    onEnd: () => finished(),
  });
  const audio = audioType();
  const picture = recorder(canvas.captureStream(30), VIDEO_MIME, { videoBitsPerSecond: 700_000 });
  const sound = recorder(player.audioStream, audio.mime, { audioBitsPerSecond: 96_000 });
  let stallTimer = 0;
  try {
    const cancelled = new Promise((_, reject) => {
      if (signal?.aborted) reject(new Error("cancelled"));
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    picture.media.start(1000);
    sound.media.start(1000);
    await player.play();
    // Real time should take the lane's length; give up if it stalls well past that.
    const stalled = new Promise((_, reject) => {
      stallTimer = setTimeout(() => reject(new Error("The recording stalled. Keep this page open in front while it records.")), player.duration * 1500 + 15_000);
    });
    await Promise.race([ended, cancelled, stalled]);
    picture.media.stop();
    sound.media.stop();
    const [videoBlob, audioBlob] = await Promise.all([picture.stopped, sound.stopped]);
    if (videoBlob.size < 1024 || audioBlob.size < 256) throw new Error("The recording came out empty. Please try again.");
    onProgress?.(1);
    return {
      video: new File([videoBlob], "lane-lens.mp4", { type: "video/mp4" }),
      audio: new File([audioBlob], `lane-sound.${audio.ext}`, { type: audio.type }),
    };
  } finally {
    clearTimeout(stallTimer);
    for (const { media } of [picture, sound]) {
      if (media.state !== "inactive") media.stop();
    }
    player.destroy();
  }
}
