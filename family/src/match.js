// Deciding whether a question that was asked has since been given an answer. This mirrors the
// matching the server and the glasses use, so "waiting" here means what it means to the wearer:
// asked again today, it would still have no answer.

const STOPWORDS = new Set(
  "a an the this that these those is are was were am be been do does did i me my mine you your it its of to in on at for with and or but so about please can could would tell say said again".split(
    " ",
  ),
);

function contentWords(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  return new Set(words.map((w) => w.replace(/(ing|ed|es|s)$/, "").replace(/^gave$|^given$/, "give")));
}

const plain = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

export function sameQuestion(a, b) {
  if (plain(a) && plain(a) === plain(b)) return true;
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  // One shared word is not the same question: see server/src/matching.js.
  if (shared < 2) return false;
  const overlap = shared / Math.min(wa.size, wb.size);
  const jaccard = shared / (wa.size + wb.size - shared);
  return 0.6 * overlap + 0.4 * jaccard >= 0.6;
}

/**
 * The questions still waiting. The server lists every question that had no answer when it was
 * asked; this drops the ones a relative has answered since.
 * @param {{open: any[], answered: any[]}} questions from GET /api/questions
 * @param {any[]} memories from GET /api/keepsakes
 */
export function stillWaiting(questions, memories) {
  const answersFor = new Map(memories.map((m) => [m.id, m.answers ?? []]));
  return questions.open.filter((item) => {
    const candidates = [...(answersFor.get(item.keepsakeId) ?? []), ...questions.answered];
    return !candidates.some((answer) => sameQuestion(item.question, answer.question));
  });
}
