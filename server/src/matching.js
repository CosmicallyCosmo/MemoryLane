// Text matching that needs no network: used first for spoken questions (fast, private) and as
// the whole matcher when no model is configured.

const STOPWORDS = new Set(
  "a an the this that these those is are was were am be been do does did i me my mine you your it its of to in on at for with and or but so about please can could would tell say said again".split(
    " ",
  ),
);

export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function contentWords(text) {
  const words = normalise(text).filter((w) => !STOPWORDS.has(w));
  // Light stemming so "gave" / "give" / "given" and plurals line up.
  return new Set(words.map((w) => w.replace(/(ing|ed|es|s)$/, "").replace(/^gave$|^given$/, "give")));
}

/** 0..1: how much of the shorter question's meaning-carrying words appear in the other. */
export function questionSimilarity(a, b) {
  // The same words in the same order is always the same question.
  if (normalise(a).join(" ") === normalise(b).join(" ") && normalise(a).length > 0) return 1;
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  // One word in common is not enough. "Where is Margaret?" and "Where am I?" share only
  // "where", and giving the answer to one for the other would tell the wearer something
  // false in a voice they trust. Anything looser than this is left to the model, or to no
  // answer at all.
  if (shared < 2) return 0;
  const overlap = shared / Math.min(wa.size, wb.size);
  const jaccard = shared / (wa.size + wb.size - shared);
  return 0.6 * overlap + 0.4 * jaccard;
}

/** Best recorded answer for a spoken question, or null when nothing is close enough. */
export function matchQuestionLocally(question, answers, threshold = 0.6) {
  let best = null;
  for (const answer of answers) {
    const score = questionSimilarity(question, answer.question);
    if (!best || score > best.score) best = { answer, score };
  }
  return best && best.score >= threshold ? best : null;
}

/**
 * "Where did this come from?", "Who gave me this?", "Where is this from?": asking who a memory is
 * from. Loose on purpose, because speech is often misheard ("where did this birthday called come
 * from"), but only ever used for the memory in view, and only when no recorded answer fits.
 */
export function asksWhoItIsFrom(text) {
  const said = normalise(text).join(" ");
  return (
    /\b(come|came|comes) from\b/.test(said) ||
    /\b(this|that|it|these|those)( [a-z]+){0,3} from$/.test(said) ||
    /\bwho( [a-z]+){0,2} (gave|give|given|sent|send|bought)\b/.test(said)
  );
}

/** A stable key for "the same question asked again", tolerant of small wording changes. */
export function questionKey(text) {
  return [...contentWords(text)].sort().join(" ");
}
