// Quiet music and the sound around it, made in the browser so there is nothing to license or
// download: slow pads of soft chords, a few soft high notes, and, if chosen, a calm sea or a
// breeze. Everything is generated from fixed seeds, so the preview, the phone and the glasses
// copy sound the same.

const MOODS = {
  // MIDI note numbers. Each chord: root for the bass, then the pad's notes.
  warm: { seconds: 8, chords: [[48, 55, 60, 64, 71], [45, 57, 60, 64, 67], [41, 57, 60, 65, 69], [43, 55, 59, 62, 67]] },
  tender: { seconds: 10, chords: [[45, 57, 60, 64, 71], [41, 57, 60, 65, 69], [48, 55, 60, 64, 67], [40, 55, 59, 64, 67]] },
  bright: { seconds: 7, chords: [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 55, 59, 62, 66], [45, 57, 61, 64, 69]] },
};

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reverbImpulse(ctx, seconds = 3.2) {
  const length = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const random = seeded(7 + c);
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * (1 - i / length) ** 2.6;
  }
  return buffer;
}

function noiseBuffer(ctx, seconds = 6) {
  const length = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = seeded(11);
  // Brown-ish noise: soft, with no hiss.
  let last = 0;
  for (let i = 0; i < length; i++) {
    last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

/**
 * Music for one lane, into `output` (a GainNode the player owns and ducks under voices).
 * Call `start(from, at)` to play from timeline time `from`, which happens at context time
 * `at`; `stop()` silences it. Works on an OfflineAudioContext too.
 */
export function createMusic(ctx, output, { music = "warm", ambience = "none", until = Infinity } = {}) {
  const mood = MOODS[music] ?? null;
  const reverb = ctx.createConvolver();
  reverb.buffer = reverbImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  reverb.connect(wet).connect(output);
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 1500;
  tone.Q.value = 0.3;
  tone.connect(output);
  tone.connect(reverb);

  let run = null;

  function note(bus, freq, begin, length, { level, attack, release, type = "sine", detune = 0 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, begin);
    env.gain.linearRampToValueAtTime(level, begin + attack);
    env.gain.setValueAtTime(level, begin + Math.max(attack, length));
    env.gain.exponentialRampToValueAtTime(0.0001, begin + Math.max(attack, length) + release);
    osc.connect(env).connect(bus);
    osc.start(begin);
    osc.stop(begin + Math.max(attack, length) + release + 0.05);
    return osc;
  }

  function chord(bus, k, begin, late) {
    const { seconds, chords } = mood;
    const [root, ...pad] = chords[k % chords.length];
    // A chord already under way when playback starts comes in quickly rather than from nothing.
    const attack = late ? 1.2 : 2.6;
    const length = seconds - late;
    for (const midi of pad) {
      note(bus, hz(midi), begin, length, { level: 0.03, attack, release: 3.2, type: "triangle" });
      note(bus, hz(midi), begin, length, { level: 0.022, attack, release: 3.2, detune: 5 });
    }
    note(bus, hz(root - 12), begin, length, { level: 0.05, attack: attack + 0.6, release: 3 });
    // A few soft high notes, the same ones every time this chord comes round.
    const random = seeded(1000 + k);
    for (const offset of [1.2, 3.6, 5.4]) {
      if (offset < late || random() < 0.35) continue;
      const midi = pad[Math.floor(random() * pad.length)] + 12;
      note(bus, hz(midi), begin + offset - late, 0.05, { level: 0.028, attack: 0.03, release: 3.6 });
      note(bus, hz(midi + 12), begin + offset - late, 0.05, { level: 0.006, attack: 0.03, release: 1.6 });
    }
  }

  function startAmbience(bus, at) {
    if (ambience !== "waves" && ambience !== "breeze") return [];
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx);
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    const level = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    if (ambience === "waves") {
      filter.type = "lowpass";
      filter.frequency.value = 700;
      level.gain.value = 0.11;
      lfo.frequency.value = 0.09; // one slow swell every eleven seconds
      depth.gain.value = 0.08;
      lfo.connect(depth).connect(level.gain);
    } else {
      filter.type = "bandpass";
      filter.frequency.value = 900;
      filter.Q.value = 0.5;
      level.gain.value = 0.07;
      lfo.frequency.value = 0.05;
      depth.gain.value = 350;
      lfo.connect(depth).connect(filter.frequency);
    }
    noise.connect(filter).connect(level).connect(bus);
    noise.start(at);
    lfo.start(at);
    return [noise, lfo];
  }

  return {
    start(from, at) {
      this.stop();
      const bus = ctx.createGain();
      bus.connect(tone);
      const sources = startAmbience(bus, at);
      let next = mood ? Math.floor(from / mood.seconds) : 0;
      let timer = 0;
      const schedule = (horizon) => {
        if (!mood) return;
        while (next * mood.seconds < Math.min(horizon, until)) {
          const begins = next * mood.seconds;
          const late = Math.max(0, from - begins);
          chord(bus, next, at + Math.max(0, begins - from), late);
          next++;
        }
      };
      if (ctx instanceof OfflineAudioContext) {
        schedule(until);
      } else {
        schedule(from + 4);
        // A little ahead of time, a chord at a time, so seeking never builds up hours of notes.
        timer = setInterval(() => schedule(from + (ctx.currentTime - at) + 4), 500);
      }
      run = { bus, sources, timer };
    },
    stop() {
      if (!run) return;
      clearInterval(run.timer);
      const { bus, sources } = run;
      const now = ctx.currentTime;
      bus.gain.setTargetAtTime(0, now, 0.05);
      for (const source of sources) {
        try {
          source.stop(now + 0.3);
        } catch {
          // Not started yet, or already stopped.
        }
      }
      setTimeout(() => bus.disconnect(), 600);
      run = null;
    },
  };
}
