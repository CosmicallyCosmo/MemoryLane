// The two places a model is used. In both, the model only *chooses* among things the family
// made: which keepsake is in view, or which recorded answer fits a question. It never writes
// words that are spoken to the wearer.
import {
  decisionsEnabled,
  geminiChooseAnswer,
  geminiConfirmKeepsake,
  geminiDecideKeepsake,
  geminiDescribeKeepsake,
  geminiImagineLookalikes,
  geminiRecognise,
} from "./gemini.js";

// A wearer is waiting with the object in their hands, so a slow answer is a wrong answer.
const RECOGNISE_TIMEOUT_MS = Number(process.env.ML_RECOGNISE_TIMEOUT_MS || 12000);
const MIN_CONFIDENCE = Number(process.env.ML_MIN_CONFIDENCE || 0.6);
// The Decisions API's choice alone cannot be trusted with look-alikes: one scored 0.993 while
// real looks scored 0.985 and up (15 Nov 2026), so no threshold on it separates them. A match
// it makes is confirmed against that keepsake alone, where real looks scored 0.83 or more for
// "the same object" and look-alikes 0.42 or less, and no real look had a check answered "no"
// above 0.14.
const CONFIRM_SAME = Number(process.env.ML_CONFIRM_SAME || 0.7);
const CONFIRM_WORST_NO = 0.8;
const usesDecisions = () => aiMode() === "gemini" && decisionsEnabled();

export function aiMode() {
  const forced = process.env.ML_RECOGNISER;
  if (forced === "rehearsal" || forced === "gemini") return forced;
  return process.env.GEMINI_API_KEY ? "gemini" : "rehearsal";
}

const RECOGNISE_SYSTEM = `You help a person living with memory loss. They wear camera glasses, and their family has registered a small set of personal keepsakes. You are shown each keepsake (name, description, reference photos), then one frame from the glasses.

Decide whether the main object in the frame, the one being held or looked at most directly, is one of the registered keepsakes.

- Match only when you are confident it is the same physical object, not merely the same kind of object. A different mug is not the family's mug.
- If nothing matches, answer "none".
- object_label is a short, plain, neutral name for the main object, such as "a television remote" or "a blue mug". Three to five words.
- Never identify or describe people. If the frame mostly shows a real person in front of the camera, use "none" and the label "a person".
- A photograph is an object: a print, a framed photo, or a picture shown on a screen. When the frame shows the same photograph as a registered keepsake's reference photo, match it, even though the photograph has people in it. Its label is "a photograph". Still say nothing about who is in it.`;

/**
 * @returns {Promise<{matchId: string|null, confidence: number, objectLabel: string, reason?: string}>}
 */
export async function recogniseKeepsake({
  frameBase64,
  keepsakes,
  mediaDir,
  hint,
}) {
  if (keepsakes.length === 0) {
    return { matchId: null, confidence: 0, objectLabel: "", reason: "no_keepsakes" };
  }

  if (aiMode() === "rehearsal") {
    // No model configured. The operator names the keepsake from the phone, which lets the
    // whole loop be rehearsed (and demoed on a bad network) without pretending to recognise.
    // ML_REHEARSAL_MEMORY names one keepsake to treat as in view on every look with no hint,
    // so a look from the glasses alone ("What's this?") can be rehearsed hands-free.
    const named = hint || process.env.ML_REHEARSAL_MEMORY;
    const wanted = String(named ?? "").toLowerCase();
    const match = wanted
      ? keepsakes.find((k) => k.id === named || k.name.toLowerCase().includes(wanted))
      : null;
    return match
      ? { matchId: match.id, confidence: 1, objectLabel: match.name, reason: "rehearsal" }
      : { matchId: null, confidence: 0, objectLabel: "something unfamiliar", reason: "rehearsal" };
  }

  const deadline = Date.now() + RECOGNISE_TIMEOUT_MS;
  const look = { system: RECOGNISE_SYSTEM, frameBase64, keepsakes, mediaDir };
  if (!decisionsEnabled()) {
    return decide(await geminiRecognise({ ...look, timeoutMs: RECOGNISE_TIMEOUT_MS }), keepsakes);
  }
  const result = await matchByDecisions({ frameBase64, keepsakes, mediaDir, deadline });
  // The Decisions API writes no text, so a miss is named by the vision model, shown the same
  // keepsakes so that it knows what the object is not. Only its label is used: the match is
  // the Decisions API's. A label not had in the time left is no label, not a failed look.
  if (result.matchId || result.reason === "declined") return result;
  try {
    const named = await geminiRecognise({ ...look, timeoutMs: deadline - Date.now() });
    return { ...result, objectLabel: named?.object_label ?? "" };
  } catch (error) {
    console.warn("label for an unknown object failed:", error?.message ?? error);
    return result;
  }
}

/** Applies the same acceptance rule whichever way the model was asked. */
function decide(parsed, keepsakes) {
  if (!parsed) return { matchId: null, confidence: 0, objectLabel: "", reason: "declined" };
  const { match_id, confidence, object_label } = parsed;
  const known = keepsakes.some((k) => k.id === match_id);
  const matched = known && confidence >= MIN_CONFIDENCE;
  return {
    matchId: matched ? match_id : null,
    confidence,
    objectLabel: object_label,
    reason: known && !matched ? "low_confidence" : undefined,
  };
}

/**
 * The Decisions API chooses, and a match it makes is then confirmed against that keepsake
 * alone. A confirmation that cannot be had in time fails the look ("could not look"), rather
 * than saying there is no memory, or letting through a match it could not check.
 */
async function matchByDecisions({ frameBase64, keepsakes, mediaDir, deadline }) {
  const chosen = decide(await geminiDecideKeepsake({ frameBase64, keepsakes, mediaDir, timeoutMs: deadline - Date.now() }), keepsakes);
  if (!chosen.matchId) return chosen;
  const keepsake = keepsakes.find((k) => k.id === chosen.matchId);
  const confirmed = await geminiConfirmKeepsake({ keepsake, frameBase64, mediaDir, timeoutMs: deadline - Date.now() });
  if (confirmed && confirmed.same >= CONFIRM_SAME && confirmed.worstNo < CONFIRM_WORST_NO) return chosen;
  return { ...chosen, matchId: null, reason: confirmed ? "not_confirmed" : "declined" };
}

// Background work shares the key with the wearer's looks, so it goes one call at a time.
const GAP_MS = Number(process.env.ML_PREPARE_GAP_MS ?? 3000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let preparing = null;
let prepareAgain = false;

/**
 * Gets each keepsake ready for the Decisions API, once, in the background, one at a time:
 *
 * 1. Writes down from its full-size photos the features that tell it apart from others of its
 *    kind, and the checks a match is confirmed by.
 * 2. Tests it: two pictures of look-alikes, made by editing its photo, are looked at as the
 *    glasses would. If either is taken for a memory, onMightBeMistaken(keepsake) is called, so
 *    the family can be asked for a close-up of what only theirs has.
 *
 * A look before this finishes goes without features or checks. What fails is tried again on
 * the next call (each start, each memory added, each photo added). One run at a time: a call
 * during a run makes it go round again when it ends.
 */
export function prepareKeepsakes(store, options = {}) {
  if (!usesDecisions()) return Promise.resolve();
  if (preparing) {
    prepareAgain = true;
    return preparing;
  }
  preparing = (async () => {
    do {
      prepareAgain = false;
      await prepareEach(store, options);
    } while (prepareAgain);
  })().finally(() => (preparing = null));
  return preparing;
}

async function prepareEach(store, { onMightBeMistaken = () => {} }) {
  for (const keepsake of store.keepsakes.filter((k) => !k.features || !k.checks || !k.lookalikeTest)) {
    // Deleted, or given new photos, since this began: what was made from the old ones is not
    // kept, and the new photos get their own turn.
    const photos = keepsake.referencePhotos.join("\n");
    const unchanged = () => store.keepsake(keepsake.id)?.referencePhotos.join("\n") === photos;
    try {
      if (!keepsake.features || !keepsake.checks) {
        const { features, checks } = await geminiDescribeKeepsake({ keepsake, mediaDir: store.mediaDir });
        if (!features || !unchanged()) continue;
        store.updateKeepsake(keepsake.id, { features, checks });
        await pause(GAP_MS);
      }
      const pictures = await geminiImagineLookalikes({ keepsake, mediaDir: store.mediaDir });
      if (!pictures.length) continue;
      let mistaken = 0;
      for (const frameBase64 of pictures) {
        await pause(GAP_MS);
        const result = await matchByDecisions({
          frameBase64,
          keepsakes: store.keepsakes,
          mediaDir: store.mediaDir,
          deadline: Date.now() + 60000,
        });
        if (result.matchId) mistaken++;
      }
      if (!unchanged()) continue;
      // The pictures are not kept: only how many were taken for a memory.
      store.updateKeepsake(keepsake.id, {
        lookalikeTest: { at: new Date().toISOString(), tried: pictures.length, mistaken },
      });
      if (mistaken) onMightBeMistaken(store.keepsake(keepsake.id));
    } catch (error) {
      console.warn(`could not prepare "${keepsake.name}": ${error?.message ?? error}`);
    }
    await pause(GAP_MS);
  }
}

const ASK_SYSTEM = `A person living with memory loss asked a question out loud about a family keepsake. Their family recorded answers to some questions in advance. Pick the recorded answer that genuinely answers what was asked. The transcription may be imperfect.

If no recorded answer fits, reply "none". Do not stretch: a wrong answer played in a loved one's voice is worse than no answer.`;

/** Chooses among the family's recorded answers. Returns an answer id or null. */
export async function chooseAnswer({ question, keepsake }) {
  if (aiMode() === "rehearsal" || keepsake.answers.length === 0) return null;
  const list = keepsake.answers
    .map((a) => `- id "${a.id}": question "${a.question}"; answer: ${a.text || "(voice recording)"}`)
    .join("\n");
  const parsed = await geminiChooseAnswer({
    system: ASK_SYSTEM,
    prompt: `Keepsake: ${keepsake.name}\n\nRecorded answers:\n${list}\n\nThe person asked: "${question}"`,
    timeoutMs: 8000,
  });
  return keepsake.answers.some((a) => a.id === parsed?.answer_id) ? parsed.answer_id : null;
}
