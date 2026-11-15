// Heart rate while a memory is open. The phone sends one session per memory opened: the resting
// rate from just before, and a reading every couple of seconds while it was open. Everything
// said about a session is a number that was measured. Nothing here names a feeling: a rise can
// come from standing up or talking as easily as from the memory.

const MIN_BPM = 30;
const MAX_BPM = 220;
const MAX_SAMPLES = 300;
const MIN_SAMPLES = 5;
/** Readings taken together when looking for a peak, so one stray beat is not a response. */
const SMOOTH = 5;
/** Beats a minute above resting, held across the smoothing window, that count as a rise. */
export const LIFTED_BY = 8;
/** Beats a minute the average must sit below resting to count as a fall. */
export const SETTLED_BY = 5;

const SOURCES = new Set(["glasses", "simulated"]);

const bpm = (value) => (Number.isFinite(value) && value >= MIN_BPM && value <= MAX_BPM ? Math.round(value) : null);

/** What the phone sent, checked and trimmed. Null if it is not a usable session. */
export function cleanSession(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.samples)) return null;
  const samples = raw.samples.slice(0, MAX_SAMPLES).map(bpm);
  if (samples.length < MIN_SAMPLES || samples.includes(null)) return null;
  const restingBpm = bpm(raw.restingBpm);
  if (restingBpm === null) return null;
  const everySec = Number.isFinite(raw.everySec) ? Math.min(Math.max(Math.round(raw.everySec), 1), 10) : 2;
  return { restingBpm, everySec, samples, source: SOURCES.has(raw.source) ? raw.source : "glasses" };
}

/** The numbers the family is shown for one session. */
export function summarise(session) {
  const { samples, restingBpm, everySec } = session;
  const window = Math.min(SMOOTH, samples.length);
  let peak = -Infinity;
  let peakIndex = 0;
  for (let i = 0; i + window <= samples.length; i++) {
    // The middle reading of each stretch: a stray one or two cannot move it.
    const middle = samples.slice(i, i + window).sort((a, b) => a - b)[Math.floor(window / 2)];
    if (middle > peak) {
      peak = middle;
      peakIndex = i + (window - 1) / 2;
    }
  }
  const averageBpm = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  const peakBpm = Math.round(peak);
  const kind = peakBpm - restingBpm >= LIFTED_BY ? "lifted" : restingBpm - averageBpm >= SETTLED_BY ? "settled" : "steady";
  return {
    kind,
    // Where the readings came from: real glasses, or simulated ones. Shown wherever the numbers are.
    source: session.source,
    restingBpm,
    peakBpm,
    averageBpm,
    // What changed, in beats a minute: up to the peak for a rise, otherwise the average against resting.
    changeBpm: kind === "lifted" ? peakBpm - restingBpm : averageBpm - restingBpm,
    peakAtSec: Math.round(peakIndex * everySec),
    lengthSec: (samples.length - 1) * everySec,
  };
}

function when(seconds) {
  if (seconds < 10) return "in the first few seconds";
  if (seconds < 55) return `about ${Math.round(seconds / 5) * 5} seconds in`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about a minute in" : `about ${minutes} minutes in`;
}

/** One sentence for a session, in words a relative would use. */
export function describeHeart(summary, wearer) {
  const whose = wearer ? `${wearer}'s` : "Their";
  switch (summary.kind) {
    case "lifted":
      return `${whose} heart rate rose from ${summary.restingBpm} to ${summary.peakBpm} beats a minute, ${when(summary.peakAtSec)}.`;
    case "settled":
      return `${whose} heart rate fell from ${summary.restingBpm} to around ${summary.averageBpm} beats a minute.`;
    default:
      return `${whose} heart rate stayed steady, around ${summary.averageBpm} beats a minute.`;
  }
}

/** Across every session for one memory. Null when there are none. */
export function typical(summaries) {
  if (!summaries.length) return null;
  const rises = summaries.filter((s) => s.kind === "lifted").map((s) => s.peakBpm - s.restingBpm);
  return {
    sessions: summaries.length,
    lifted: rises.length,
    settled: summaries.filter((s) => s.kind === "settled").length,
    // How many of the sessions were made up by simulated glasses, not measured.
    simulated: summaries.filter((s) => s.source === "simulated").length,
    // How far above resting the peak was, across the times it rose.
    averageRise: rises.length ? Math.round(rises.reduce((sum, value) => sum + value, 0) / rises.length) : 0,
    lastKind: summaries[summaries.length - 1].kind,
  };
}
