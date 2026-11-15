// When everything in a memory lane happens, worked out from the plan and the real length of
// each voice message. The plan's times are wishes; the rules here are not: every photo stays
// long enough to take in, and every change is a slow fade.

/** How long each photo stays at least, and how long each fade takes, in seconds. */
export const PACES = {
  gentle: { minShot: 7, fade: 2.6 },
  slower: { minShot: 10, fade: 3.6 },
};

const INTRO = 2.5; // fade up from black at the start
const OUTRO = 2.5; // fade to black at the end
const LEAD = 1.8; // the memory's name shows, then its voice message starts
const FIRST_LEAD = 1.4; // a little extra the first time, while the picture fades up
const TAIL = 2; // the last photo stays this long after the voice ends
const CAPTION = 7; // how long a memory's name stays up
const MAX_VIDEO = 20;
const LINE_CHARS = 70; // the most words shown at once: three short lines on the glasses
const LINE_STEP = 0.3; // each line comes up this much before its share of the recording
const MIN_LINE = 1.5; // no line goes by too fast to read
const NAME_OVER = 1.2; // the name stays this far into the voice message, then the words take over

/**
 * The family's written words in pieces short enough to read at a glance: sentences, and long
 * sentences cut at commas, then between words.
 */
export function wordLines(words) {
  const pieces = [];
  for (const sentence of String(words ?? "").trim().split(/(?<=[.!?])\s+/).filter(Boolean)) {
    let line = "";
    for (const part of sentence.length > LINE_CHARS ? sentence.split(/(?<=,)\s+|\s+/) : [sentence]) {
      if (line && (line + " " + part).length > LINE_CHARS) {
        pieces.push(line);
        line = part;
      } else line = line ? `${line} ${part}` : part;
    }
    if (line) pieces.push(line);
  }
  return pieces;
}

/**
 * @param {{pace?: string, segments: {name: string, from: string, voice: string|null, words?: string,
 *   shots: {at: number|null, kind: string}[]}[]}} lane
 * @param {(segment: number) => number} voiceLength seconds, 0 for none
 * @param {(segment: number, shot: number) => number} videoLength seconds, for video shots
 */
export function buildTimeline(lane, voiceLength, videoLength = () => 0) {
  const pace = PACES[lane.pace] ?? PACES.gentle;
  const shots = [];
  const voices = [];
  const captions = [];
  const lines = [];
  let t = 0;

  lane.segments.forEach((segment, s) => {
    const start = t;
    const voiceAt = start + LEAD + (s === 0 ? FIRST_LEAD : 0);
    const voice = voiceLength(s);
    const hold = (j) =>
      segment.shots[j].kind === "video" ? Math.max(pace.minShot, Math.min(videoLength(s, j) || 0, MAX_VIDEO)) : pace.minShot;

    // Wished-for start times: the plan's, or evenly across the voice message.
    const count = segment.shots.length;
    const span = Math.max(voice, count * pace.minShot);
    const order = segment.shots
      .map((shot, j) => ({ j, wish: j === 0 ? start : typeof shot.at === "number" ? voiceAt + shot.at : start + (j * span) / count }))
      .sort((a, b) => a.wish - b.wish || a.j - b.j);

    let previous = null;
    for (const { j, wish } of order) {
      const begin = previous === null ? start : Math.max(wish, previous.begin + hold(previous.j));
      shots.push({ ...segment.shots[j], segment: s, index: j, start: begin });
      previous = { j, begin };
    }
    const end = Math.max(voice ? voiceAt + voice + TAIL : start, previous.begin + hold(previous.j));
    if (voice) voices.push({ segment: s, src: segment.voice, start: voiceAt, duration: voice });
    // The family's words keep pace with the voice message, each piece given a share of it by its
    // length, as on the glasses' own memory screen. They are what the family wrote, not a
    // transcript, so they follow the recording rather than match it word for word.
    const pieces = voice ? wordLines(segment.words) : [];
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    let before = 0;
    const first = lines.length;
    for (const text of pieces) {
      const earliest = lines.length > first ? lines[lines.length - 1].start + MIN_LINE : voiceAt + NAME_OVER;
      lines.push({ start: Math.max(earliest, voiceAt + (voice * before) / total - LINE_STEP), text });
      before += text.length;
    }
    for (let i = first; i < lines.length; i++) lines[i].end = i + 1 < lines.length ? lines[i + 1].start : voiceAt + voice + 0.8;
    // The name and who it is from come first, and give way to the words.
    const nameStart = start + (s === 0 ? INTRO * 0.6 : 0.4);
    const nameEnd = start + CAPTION + (s === 0 ? INTRO : 0);
    captions.push({ start: nameStart, end: pieces.length ? Math.min(nameEnd, voiceAt + NAME_OVER) : nameEnd, name: segment.name, from: segment.from });
    t = end;
  });

  const outroStart = Math.max(t - 1, 0);
  const duration = outroStart + OUTRO;
  shots.forEach((shot, i) => {
    shot.end = i + 1 < shots.length ? shots[i + 1].start : duration;
  });
  return { shots, voices, captions, lines, duration, fade: pace.fade, intro: INTRO, outroStart, outro: OUTRO };
}

/** The shot showing at time t, and the one it is fading from (or null). */
export function shotsAt(timeline, t) {
  const { shots, fade } = timeline;
  let i = 0;
  while (i + 1 < shots.length && shots[i + 1].start <= t) i++;
  const current = shots[i];
  const progress = i > 0 ? Math.min(1, Math.max(0, (t - current.start) / fade)) : 1;
  return { current, previous: progress < 1 ? shots[i - 1] : null, progress };
}
