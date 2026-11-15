// The carer's weekly picture, built only from the event log.
import { questionKey } from "./matching.js";

const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const REPEAT_COUNT = 3;

export function buildSummary({ events, keepsakes, days = 7, now = Date.now() }) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const recent = events.filter((e) => Date.parse(e.at) >= since);
  const nameOf = (id) => keepsakes.find((k) => k.id === id)?.name ?? "A removed keepsake";

  const looks = recent.filter((e) => e.type === "look");
  const matched = looks.filter((e) => e.matchId);
  const questions = recent.filter((e) => e.type === "question");

  const byKeepsake = new Map();
  for (const e of matched) byKeepsake.set(e.matchId, (byKeepsake.get(e.matchId) ?? 0) + 1);

  const unknown = new Map();
  for (const e of looks) {
    if (e.matchId || !e.objectLabel) continue;
    unknown.set(e.objectLabel, (unknown.get(e.objectLabel) ?? 0) + 1);
  }

  const unanswered = new Map();
  for (const e of questions) {
    if (e.answerId) continue;
    const key = `${e.keepsakeId}|${questionKey(e.question)}`;
    const entry = unanswered.get(key) ?? {
      keepsakeId: e.keepsakeId,
      keepsake: e.keepsakeId ? nameOf(e.keepsakeId) : "",
      question: e.question,
      count: 0,
    };
    entry.count++;
    unanswered.set(key, entry);
  }

  // The same question several times in a short while can mean the wearer is unsettled.
  // That is a prompt for a person to check in, never a diagnosis.
  const groups = new Map();
  for (const e of questions) {
    const key = `${e.keepsakeId}|${e.answerId ?? questionKey(e.question)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const nudges = [];
  for (const group of groups.values()) {
    const times = group.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
    let best = 0;
    let start = 0;
    for (let end = 0; end < times.length; end++) {
      while (times[end] - times[start] > REPEAT_WINDOW_MS) start++;
      best = Math.max(best, end - start + 1);
    }
    if (best >= REPEAT_COUNT) {
      const last = group[group.length - 1];
      nudges.push({
        keepsake: nameOf(last.keepsakeId),
        question: last.question,
        timesInHalfHour: best,
        lastAt: last.at,
      });
    }
  }

  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    daily.push({
      day,
      memories: matched.filter((e) => e.at.startsWith(day)).length,
      questions: questions.filter((e) => e.at.startsWith(day)).length,
    });
  }

  const timed = looks.filter((e) => Number.isFinite(e.latencyMs)).map((e) => e.latencyMs);
  timed.sort((a, b) => a - b);

  return {
    days,
    looks: looks.length,
    memoriesPlayed: matched.length,
    questionsAsked: questions.length,
    questionsAnswered: questions.filter((e) => e.answerId).length,
    keepsakes: [...byKeepsake]
      .map(([id, count]) => ({ id, name: nameOf(id), count }))
      .sort((a, b) => b.count - a.count),
    unknownObjects: [...unknown]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    unansweredQuestions: [...unanswered.values()].sort((a, b) => b.count - a.count),
    nudges: nudges.sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    daily,
    medianRecogniseMs: timed.length ? timed[Math.floor(timed.length / 2)] : null,
    pauses: recent.filter((e) => e.type === "privacy_pause").length,
  };
}
