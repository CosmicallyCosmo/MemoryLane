// Plays a memory lane into a canvas: the family's photos and videos drifting slowly forward
// out of a soft, dark tunnel, the family's own voice messages, and quiet music underneath.
// Used by the family app (to preview, and to record the glasses copy) and by the phone.
//
// Made for an older person watching: nothing is sudden. Every change is a slow cross-fade,
// movement is a gentle push towards the subject, and the subject of each photo stays where
// the last one's was while they fade, so the eye has nowhere new to jump to. Whole photos are
// shown, never cropped faces. Music sits well under the voices and dips further while anyone
// speaks.
import { createMusic } from "./music.js";
import { buildTimeline, shotsAt } from "./timeline.js";

const VOICE_RMS = 0.12; // voice messages are brought to about the same loudness
const MUSIC_LEVEL = 0.5; // the music's own mix is already quiet; this is the bus level
const MUSIC_UNDER_VOICE = 0.2;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** Soft edges, so a photo melts into the dark around it instead of sitting in a frame. */
function feather(context, width, height) {
  const edge = Math.round(Math.min(width, height) * 0.08);
  context.save();
  context.globalCompositeOperation = "destination-out";
  const sides = [
    [0, 0, width, edge, 0, 0, 0, edge],
    [0, height - edge, width, edge, 0, height, 0, height - edge],
    [0, 0, edge, height, 0, 0, edge, 0],
    [width - edge, 0, edge, height, width, 0, width - edge, 0],
  ];
  for (const [x, y, w, h, x0, y0, x1, y1] of sides) {
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(x, y, w, h);
  }
  context.restore();
}

function canvasOf(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** A very small copy, drawn large: a soft blur of the picture for the background. */
function blurInto(target, source, width, height) {
  const tiny = target.getContext("2d");
  tiny.imageSmoothingQuality = "high";
  tiny.drawImage(source, 0, 0, width, height, 0, 0, target.width, target.height);
}

/** A photo or video ready to draw: a feathered picture and a blurred background. */
class Picture {
  constructor(source, width, height, video = null) {
    const scale = Math.min(1, 1280 / Math.max(width, height));
    this.width = width * scale;
    this.height = height * scale;
    this.source = source;
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.video = video;
    this.canvas = canvasOf(this.width, this.height);
    this.backdrop = canvasOf(24, Math.max(1, (24 * height) / width));
    this.refresh();
  }

  refresh() {
    const context = this.canvas.getContext("2d");
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(this.source, 0, 0, this.canvas.width, this.canvas.height);
    feather(context, this.canvas.width, this.canvas.height);
    blurInto(this.backdrop, this.source, this.sourceWidth, this.sourceHeight);
  }
}

async function loadPhoto(src) {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();
  return new Picture(img, img.naturalWidth, img.naturalHeight);
}

async function loadVideo(src) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  await new Promise((resolve, reject) => {
    video.addEventListener("loadeddata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("video")), { once: true });
    setTimeout(() => reject(new Error("video timed out")), 20_000);
  });
  return new Picture(video, video.videoWidth, video.videoHeight, video);
}

async function loadVoice(ctx, src) {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`voice ${response.status}`);
  const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
  // Loudness, from the parts that are not silence, so quiet recordings are brought up.
  let sum = 0;
  let counted = 0;
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 64) {
    const v = data[i];
    if (Math.abs(v) > 0.01) {
      sum += v * v;
      counted++;
    }
  }
  const rms = counted ? Math.sqrt(sum / counted) : VOICE_RMS;
  return { buffer, gain: Math.min(4, Math.max(0.5, VOICE_RMS / rms)) };
}

/** Points of light drifting slowly outwards: the feeling of moving forward. */
function makeMotes(count = 34) {
  let seed = 3;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: count }, () => ({ angle: random() * Math.PI * 2, phase: random(), size: 0.6 + random() * 1.2 }));
}

/**
 * @param {{canvas: HTMLCanvasElement, lane: object, record?: boolean,
 *   onTime?: (t: number) => void, onEnd?: () => void}} options
 *   `record`: no sound to the speakers; `audioStream` carries it instead, for recording.
 */
export async function createLanePlayer({ canvas, lane, record = false, onTime, onEnd }) {
  const Context = window.AudioContext || window.webkitAudioContext;
  const ctx = new Context();
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 4;
  master.connect(limiter);
  let recordDestination = null;
  if (record) {
    recordDestination = ctx.createMediaStreamDestination();
    limiter.connect(recordDestination);
  } else {
    limiter.connect(ctx.destination);
  }
  const voiceBus = ctx.createGain();
  voiceBus.connect(master);
  const musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);

  // Load everything first. Anything that will not load is left out rather than stopping it.
  const pictures = new Map();
  const voices = new Map();
  await Promise.all(
    lane.segments.flatMap((segment, s) => [
      ...segment.shots.map(async (shot) => {
        try {
          pictures.set(shot.src, shot.kind === "video" ? await loadVideo(shot.src) : await loadPhoto(shot.src));
        } catch {
          // Missing picture: its shot is dropped below.
        }
      }),
      segment.voice
        ? loadVoice(ctx, segment.voice)
            .then((voice) => voices.set(s, voice))
            .catch(() => {})
        : null,
    ]),
  );
  const usable = {
    ...lane,
    segments: lane.segments
      .map((segment, s) => ({ ...segment, original: s, shots: segment.shots.filter((shot) => pictures.has(shot.src)) }))
      .filter((segment) => segment.shots.length),
  };
  if (!usable.segments.length) {
    ctx.close();
    throw new Error("None of the photos in this lane could be loaded.");
  }
  const timeline = buildTimeline(
    usable,
    (s) => voices.get(usable.segments[s].original)?.buffer.duration ?? 0,
    (s, j) => pictures.get(usable.segments[s].shots[j].src)?.video?.duration ?? 0,
  );
  timeline.voices.forEach((voice) => (voice.loaded = voices.get(usable.segments[voice.segment].original)));

  const music = createMusic(ctx, musicBus, { music: lane.music, ambience: lane.ambience, until: timeline.duration });
  const motes = makeMotes();
  const context = canvas.getContext("2d");

  let position = 0; // timeline seconds, while paused
  let origin = 0; // context time of timeline 0, while playing
  let playing = false;
  let sources = [];
  let frame = 0;
  let destroyed = false;

  const now = () => (playing ? Math.min(timeline.duration, ctx.currentTime - origin) : position);

  function scheduleSound(from) {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    sources = [];
    const at = ctx.currentTime + 0.08;
    origin = at - from;
    for (const voice of timeline.voices) {
      if (voice.start + voice.duration <= from) continue;
      const source = ctx.createBufferSource();
      source.buffer = voice.loaded.buffer;
      const level = ctx.createGain();
      level.gain.value = voice.loaded.gain;
      source.connect(level).connect(voiceBus);
      const offset = Math.max(0, from - voice.start);
      source.start(origin + voice.start + offset, offset);
      sources.push(source);
    }
    // The music fades in, dips under every voice, and fades out with the picture.
    const gain = musicBus.gain;
    gain.cancelScheduledValues(0);
    gain.setValueAtTime(0, at);
    const levelAt = (t) => {
      if (t >= timeline.outroStart) return MUSIC_LEVEL * (1 - clamp01((t - timeline.outroStart) / timeline.outro));
      const speaking = timeline.voices.some((v) => t > v.start - 0.8 && t < v.start + v.duration + 1);
      return speaking ? MUSIC_UNDER_VOICE : MUSIC_LEVEL;
    };
    gain.linearRampToValueAtTime(levelAt(from + 2), at + 2);
    const turns = timeline.voices
      .flatMap((v) => [v.start - 0.8, v.start + v.duration + 1])
      .filter((t) => t > from + 2 && t < timeline.outroStart)
      .sort((a, b) => a - b);
    for (const t of turns) {
      gain.setTargetAtTime(levelAt(t + 0.01), origin + t, 0.35);
    }
    if (timeline.outroStart > from + 2) gain.setTargetAtTime(0, origin + timeline.outroStart, timeline.outro / 3);
    music.start(from, at);
  }

  function syncVideos(t, visible) {
    for (const picture of pictures.values()) {
      const video = picture.video;
      if (!video) continue;
      const shot = visible.find((s) => s && pictures.get(s.src) === picture);
      if (!shot || !playing) {
        if (!video.paused) video.pause();
        continue;
      }
      const expected = Math.min(Math.max(0, t - shot.start), Math.max(0, video.duration - 0.05));
      if (Math.abs(video.currentTime - expected) > 0.5) video.currentTime = expected;
      if (video.paused && expected < video.duration - 0.1) video.play().catch(() => {});
    }
  }

  /** Where a shot's picture sits at time t: its scale and where its subject is on screen. */
  function place(shot, t, width, height) {
    const picture = pictures.get(shot.src);
    const fit = Math.min((width * 0.84) / picture.width, (height * 0.84) / picture.height);
    const life = ease((t - shot.start) / (shot.end + timeline.fade - shot.start));
    let zoom = 1.02 + 0.015 * life;
    let pull = 0;
    let drift = 0;
    if (shot.motion === "push-in") {
      zoom = 1 + 0.1 * life;
      pull = 0.35 * life;
    } else if (shot.motion === "drift-left" || shot.motion === "drift-right") {
      zoom = 1.04 + 0.02 * life;
      drift = (shot.motion === "drift-left" ? -1 : 1) * 0.035 * width * (life - 0.5);
    }
    const scale = fit * zoom;
    const [fx, fy] = shot.focus ?? [0.5, 0.45];
    const natural = [width / 2 + (fx - 0.5) * picture.width * scale, height / 2 + (fy - 0.5) * picture.height * scale];
    return {
      picture,
      scale,
      anchor: [fx, fy],
      focus: [lerp(natural[0], width / 2, pull) + drift, lerp(natural[1], height / 2, pull)],
    };
  }

  function drawPicture({ picture, scale, anchor, focus }, alpha, extra = 1) {
    if (alpha <= 0.002) return;
    const [fx, fy] = anchor;
    const w = picture.width * scale * extra;
    const h = picture.height * scale * extra;
    context.globalAlpha = alpha;
    context.drawImage(picture.canvas, focus[0] - fx * w, focus[1] - fy * h, w, h);
    context.globalAlpha = 1;
  }

  function drawBackdrop(picture, alpha, width, height) {
    if (alpha <= 0.002) return;
    const b = picture.backdrop;
    const cover = Math.max(width / b.width, height / b.height) * 1.15;
    context.globalAlpha = alpha;
    context.drawImage(b, (width - b.width * cover) / 2, (height - b.height * cover) / 2, b.width * cover, b.height * cover);
    context.globalAlpha = 1;
  }

  function drawMotes(t, width, height) {
    const reach = Math.hypot(width, height) / 2;
    const unit = Math.min(width, height) / 400;
    context.fillStyle = "rgb(255, 238, 205)";
    for (const mote of motes) {
      const cycle = (mote.phase + t / 16) % 1;
      const r = reach * cycle ** 1.6;
      const alpha = 0.32 * Math.sin(Math.PI * cycle);
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(width / 2 + Math.cos(mote.angle) * r, height / 2 + Math.sin(mote.angle) * r * 0.8, mote.size * unit * (0.5 + cycle), 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function drawCaption(t, width, height) {
    const line = timeline.lines.find((l) => t >= l.start && t < l.end);
    if (line) return drawLine(line, t, width, height);
    const caption = timeline.captions.find((c) => t >= c.start && t < c.end);
    if (!caption) return;
    const alpha = Math.min(ease((t - caption.start) / 1.2), ease((caption.end - t) / 1.2));
    const small = height < 400;
    const nameSize = Math.round(height * (small ? 0.09 : 0.062));
    const fromSize = Math.round(nameSize * 0.68);
    const pad = Math.round(Math.min(width, height) * 0.07);
    const scrim = context.createLinearGradient(0, height * 0.55, 0, height);
    scrim.addColorStop(0, "rgba(8,6,4,0)");
    scrim.addColorStop(1, "rgba(8,6,4,0.7)");
    context.globalAlpha = alpha;
    context.fillStyle = scrim;
    context.fillRect(0, height * 0.55, width, height * 0.45);
    context.fillStyle = "#fbf6ec";
    context.textBaseline = "alphabetic";
    context.font = `600 ${nameSize}px Georgia, "Times New Roman", serif`;
    const fromLine = caption.from ? `From ${caption.from}` : "";
    const nameY = height - pad - (fromLine ? fromSize * 1.35 : 0);
    fitText(caption.name, pad, nameY, width - pad * 2);
    if (fromLine) {
      context.font = `400 ${fromSize}px Georgia, "Times New Roman", serif`;
      context.fillStyle = "rgba(251,246,236,0.85)";
      fitText(fromLine, pad, height - pad, width - pad * 2);
    }
    context.globalAlpha = 1;
  }

  /** The family's words for this moment, wrapped, on the same dark fade at the foot. */
  function drawLine(line, t, width, height) {
    const alpha = Math.min(ease((t - line.start) / 0.5), ease((line.end - t) / 0.5));
    const size = Math.round(height * (height < 400 ? 0.068 : 0.045));
    const pad = Math.round(Math.min(width, height) * 0.07);
    context.font = `400 ${size}px Georgia, "Times New Roman", serif`;
    const rows = [];
    for (const word of line.text.split(/\s+/)) {
      const last = rows.length ? `${rows[rows.length - 1]} ${word}` : word;
      if (rows.length && context.measureText(last).width <= width - pad * 2) rows[rows.length - 1] = last;
      else rows.push(word);
    }
    const top = height - pad - size * 1.3 * (rows.length - 1) - size * 1.6;
    const scrim = context.createLinearGradient(0, top - size * 2, 0, height);
    scrim.addColorStop(0, "rgba(8,6,4,0)");
    scrim.addColorStop(0.35, "rgba(8,6,4,0.6)");
    scrim.addColorStop(1, "rgba(8,6,4,0.8)");
    context.globalAlpha = alpha;
    context.fillStyle = scrim;
    context.fillRect(0, top - size * 2, width, height - top + size * 2);
    context.fillStyle = "#fbf6ec";
    context.textBaseline = "alphabetic";
    rows.forEach((row, i) => context.fillText(row, pad, height - pad - size * 1.3 * (rows.length - 1 - i)));
    context.globalAlpha = 1;
  }

  function fitText(text, x, y, max) {
    let shown = text;
    while (shown.length > 4 && context.measureText(shown).width > max) shown = `${shown.slice(0, -2).trimEnd()}…`;
    context.fillText(shown, x, y);
  }

  function draw(t) {
    const width = canvas.width;
    const height = canvas.height;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "#0b0907";
    context.fillRect(0, 0, width, height);

    const { current, previous, progress } = shotsAt(timeline, t);
    const blend = ease(progress);
    if (previous) drawBackdrop(pictures.get(previous.src), 1, width, height);
    drawBackdrop(pictures.get(current.src), previous ? blend : 1, width, height);
    // Darken the background so the photo itself is what the eye rests on.
    context.fillStyle = "rgba(11,9,7,0.55)";
    context.fillRect(0, 0, width, height);
    drawMotes(t, width, height);

    for (const picture of [current, previous]) if (picture?.kind === "video") pictures.get(picture.src).refresh();
    const now = place(current, t, width, height);
    if (previous) {
      const before = place(previous, t, width, height);
      // The old photo carries on forward and fades; the new one comes in with its subject
      // where the old one's was, and settles into its own place.
      drawPicture(before, 1 - blend, 1 + 0.05 * blend);
      now.focus = [lerp(before.focus[0], now.focus[0], blend), lerp(before.focus[1], now.focus[1], blend)];
      drawPicture(now, blend, 0.94 + 0.06 * blend);
    } else {
      drawPicture(now, 1);
    }

    // The tunnel: darker towards the edges.
    const vignette = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.hypot(width, height) * 0.55);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.6)");
    context.fillStyle = vignette;
    context.fillRect(0, 0, width, height);

    drawCaption(t, width, height);

    const dark = Math.max(1 - ease(t / timeline.intro), ease((t - timeline.outroStart) / timeline.outro));
    if (dark > 0) {
      context.fillStyle = `rgba(0,0,0,${dark})`;
      context.fillRect(0, 0, width, height);
    }
    syncVideos(t, [current, previous]);
  }

  let drawnAt = -1;
  function tick() {
    if (destroyed) return;
    const t = now();
    // Paused and unchanged: nothing to redraw.
    if (!playing && t === drawnAt) return;
    drawnAt = t;
    draw(t);
    onTime?.(t);
    if (playing && t >= timeline.duration) {
      pause();
      position = timeline.duration;
      onEnd?.();
    }
  }

  // Animation frames on screen; a timer when recording, which keeps going in a background tab.
  const loop = () => {
    tick();
    if (!destroyed) frame = record ? setTimeout(loop, 1000 / 30) : requestAnimationFrame(loop);
  };
  loop();

  function pause() {
    if (!playing) return;
    position = now();
    playing = false;
    music.stop();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    sources = [];
    for (const picture of pictures.values()) picture.video?.pause();
    musicBus.gain.cancelScheduledValues(0);
    musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  return {
    duration: timeline.duration,
    timeline,
    get playing() {
      return playing;
    },
    get time() {
      return now();
    },
    /** Sound for MediaRecorder when `record` is set. */
    audioStream: recordDestination?.stream ?? null,
    async play() {
      if (playing || destroyed) return;
      if (position >= timeline.duration - 0.05) position = 0;
      await ctx.resume();
      // A resume the browser held back until a tap can finish after a later play() did.
      if (playing || destroyed) return;
      playing = true;
      scheduleSound(position);
    },
    pause,
    /** Draws again, for when the canvas changed size while paused. */
    redraw() {
      drawnAt = -1;
    },
    seek(t) {
      const target = Math.min(Math.max(0, t), timeline.duration);
      if (playing) {
        scheduleSound(target);
      } else {
        position = target;
      }
    },
    /** True once sound can play; false while the browser waits for a tap. */
    get audible() {
      return ctx.state === "running";
    },
    destroy() {
      destroyed = true;
      pause();
      if (record) clearTimeout(frame);
      else cancelAnimationFrame(frame);
      for (const picture of pictures.values()) {
        if (picture.video) {
          picture.video.pause();
          picture.video.removeAttribute("src");
          picture.video.load();
        }
      }
      ctx.close().catch(() => {});
    },
  };
}
