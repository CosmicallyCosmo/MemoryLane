import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ML_RECOGNISER = "rehearsal";
const { recogniseKeepsake } = await import("../src/ai.js");

const keepsakes = [
  { id: "k_teapot", name: "Blue teapot" },
  { id: "k_badge", name: "Conference badge" },
];

test("in rehearsal mode a look with no hint finds nothing by default", async () => {
  delete process.env.ML_REHEARSAL_MEMORY;
  const result = await recogniseKeepsake({ frameBase64: "", keepsakes });
  assert.equal(result.matchId, null);
});

test("ML_REHEARSAL_MEMORY is found on every look the phone does not name", async () => {
  process.env.ML_REHEARSAL_MEMORY = "badge";
  try {
    assert.equal((await recogniseKeepsake({ frameBase64: "", keepsakes })).matchId, "k_badge");
    // A memory the phone names still wins.
    assert.equal((await recogniseKeepsake({ frameBase64: "", keepsakes, hint: "k_teapot" })).matchId, "k_teapot");
  } finally {
    delete process.env.ML_REHEARSAL_MEMORY;
  }
});
