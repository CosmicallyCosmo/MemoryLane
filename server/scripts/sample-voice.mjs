// A stand-in for a relative's voice message, for the seed scripts and the end-to-end test:
// a few seconds of a quiet tone as a WAV file. Every memory needs a voice message.

/** `seconds` of a soft 330 Hz tone, as WAV bytes. */
export function toneWav(seconds = 2) {
  const rate = 16000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 330) * 6000), 44 + i * 2);
  }
  return buffer;
}

/** The same, as a file to upload. */
export const sampleVoice = (seconds) => new File([toneWav(seconds)], "voice.wav", { type: "audio/wav" });
