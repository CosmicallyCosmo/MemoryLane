// Browser-side media work: shrinking photos and recording voice. Nothing here talks to the
// server. (The glasses copy of a memory lane is made in lane/lens.js.)

const PHOTO_MAX_SIDE = 1024;
const PHOTO_QUALITY = 0.85;

export class MediaError extends Error {}

async function decodeImage(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> route, which copes with a few more formats.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Shrinks a photo to at most 1024px on its long side and re-encodes it as JPEG (quality 0.85).
 * Keeps recognition fast and uploads small. Throws MediaError if the browser cannot read it.
 */
export async function downscalePhoto(file) {
  let source;
  try {
    source = await decodeImage(file);
  } catch {
    throw new MediaError(
      `We couldn't open "${file.name}". Please choose a JPEG, PNG or WebP photo.`,
    );
  }
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) {
    throw new MediaError(`We couldn't open "${file.name}". Please choose a different photo.`);
  }
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  // JPEG has no transparency; give see-through PNGs a white background rather than black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (typeof source.close === "function") source.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
  if (!blob) throw new MediaError(`We couldn't prepare "${file.name}". Please try another photo.`);
  const base = file.name.replace(/\.[^.]+$/, "") || "photo";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
}

// ---- Voice recording -------------------------------------------------------------------

const AUDIO_TYPES = [
  { mime: "audio/webm;codecs=opus", type: "audio/webm", ext: "webm" },
  { mime: "audio/webm", type: "audio/webm", ext: "webm" },
  { mime: "audio/mp4", type: "audio/mp4", ext: "m4a" },
  { mime: "audio/ogg;codecs=opus", type: "audio/ogg", ext: "ogg" },
];

export function canRecordAudio() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

/**
 * Starts recording from the microphone. Returns { stop, cancel }: `stop()` resolves with a File,
 * `cancel()` throws the recording away. Both release the microphone.
 */
export async function startAudioRecording(baseName = "recording") {
  if (!canRecordAudio()) {
    throw new MediaError("This browser can't record sound. You can use a recording you already have instead.");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    throw new MediaError(
      denied
        ? "Memory Lane needs permission to use your microphone. Look for the microphone symbol near the web address, choose Allow, and try again. Or use a recording you already have."
        : "We couldn't find a microphone on this device. You can use a recording you already have instead.",
    );
  }
  const chosen = AUDIO_TYPES.find((t) => MediaRecorder.isTypeSupported(t.mime));
  let recorder;
  try {
    recorder = chosen ? new MediaRecorder(stream, { mimeType: chosen.mime }) : new MediaRecorder(stream);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw new MediaError("This browser can't record sound. You can use a recording you already have instead.");
  }
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  const release = () => stream.getTracks().forEach((track) => track.stop());
  recorder.start();

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.addEventListener(
          "stop",
          () => {
            release();
            const mime = (recorder.mimeType || chosen?.mime || "audio/webm").split(";")[0];
            const ext = AUDIO_TYPES.find((t) => t.type === mime)?.ext ?? "webm";
            const blob = new Blob(chunks, { type: mime });
            if (!blob.size) {
              reject(new MediaError("Nothing was recorded that time. Please try again."));
              return;
            }
            resolve(new File([blob], `${baseName}.${ext}`, { type: mime }));
          },
          { once: true },
        );
        if (recorder.state === "inactive") recorder.dispatchEvent(new Event("stop"));
        else recorder.stop();
      }),
    cancel: () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // Already stopped.
      }
      release();
    },
  };
}
