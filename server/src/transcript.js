// Writing down what a voice message says, so the family does not have to type it.
//
// The words on the glasses are the family's own. This only offers them a draft of what they
// already said: nothing is saved here, and nothing reaches the wearer until a relative has read
// it through and saved it as the memory's story. A mishearing left in would be the model putting
// words in someone's mouth, which is why it is never saved for them.
import { aiMode } from "./ai.js";
import { geminiJson, inlineMedia } from "./gemini.js";

const SYSTEM = `You are given a short voice message a relative recorded for a family member living with memory loss. Write down exactly what is said, word for word, in the language spoken, with ordinary punctuation. Add nothing, leave nothing out, and do not tidy it up or describe the recording. If nothing is said, answer with an empty string.`;

const TIMEOUT_MS = Number(process.env.ML_TRANSCRIPT_TIMEOUT_MS || 30_000);

export function registerTranscripts(app, { store }) {
  app.post("/api/keepsakes/:id/transcript", async (req, res) => {
    const keepsake = store.keepsake(req.params.id);
    if (!keepsake) return res.status(404).json({ error: "Not found." });
    if (!keepsake.voiceNote) return res.status(400).json({ error: "This memory has no voice message to write down." });
    if (aiMode() !== "gemini") {
      return res.status(409).json({ error: "Writing a recording down needs the Gemini model, which isn't set up on this server. You can still type it." });
    }
    const recording = inlineMedia(keepsake.voiceNote, store.mediaDir);
    if (!recording) return res.status(415).json({ error: "This kind of recording can't be written down. You can still type it." });
    try {
      const answer = await geminiJson({
        system: SYSTEM,
        parts: [recording],
        schema: { type: "OBJECT", properties: { transcript: { type: "STRING" } }, required: ["transcript"] },
        timeoutMs: TIMEOUT_MS,
      });
      const text = String(answer?.transcript ?? "").trim().slice(0, 1200);
      if (!text) return res.status(422).json({ error: "No words could be made out in the recording. You can still type it." });
      res.json({ text });
    } catch (error) {
      console.warn("transcript failed:", error?.message ?? error);
      res.status(503).json({ error: "The recording couldn't be written down just now. Try again in a minute, or type it." });
    }
  });
}
