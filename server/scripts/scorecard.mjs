#!/usr/bin/env node
// Recognition scorecard: how often does the server recognise the right keepsake, how often
// does it wrongly "recognise" something else, and how long does a look take?
//
// Lay photos out like this (JPEG, PNG or WebP, each under about 1 MB):
//
//   <folder>/keepsakes/<keepsake name or id>/*.jpg    frames that SHOULD match that keepsake
//   <folder>/distractors/*.jpg                        frames that should match nothing
//
// Take them the way the glasses would see the object: held in a hand, at arm's length, in the
// room's own light. The server must be running with a vision model (not rehearsal mode) and
// the keepsakes must already be added in the family app.
//
//   npm run scorecard -- <folder>
//   npm run scorecard -- <folder> http://127.0.0.1:8795 --runs 3
//
// From another machine, pass the household code:  ML_CODE=ABCD2345 npm run scorecard -- ...
//
// Exits 1 if any distractor was matched. A wrong memory played to the wearer is the worst
// outcome, so that is the one result this treats as a failure.
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 1_000_000;
const GAP_MS = 300;
const IMAGE = /\.(jpe?g|png|webp)$/i;

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 2) : 2;
const positional = args.filter((a, i) => !a.startsWith("--") && (runsAt < 0 || i !== runsAt + 1));
const base = (positional.find((a) => /^https?:\/\//.test(a)) ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const folder = positional.find((a) => !/^https?:\/\//.test(a));
const headers = process.env.ML_CODE ? { "x-memorylane-code": process.env.ML_CODE } : {};

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!folder) fail("Usage: npm run scorecard -- <folder> [server url] [--runs N]");
if (!fs.existsSync(folder)) fail(`No such folder: ${folder}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function images(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile() || !IMAGE.test(name)) continue;
    if (fs.statSync(file).size > MAX_BYTES) {
      console.warn(`Skipping ${file}: over 1 MB. Resize it to about 1000 px on the long side.`);
      continue;
    }
    found.push(file);
  }
  return found;
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(base + url, { headers });
  } catch {
    fail(`No Memory Lane server answered at ${base}. Start it with "npm start" first.`);
  }
  if (response.status === 401) fail("The server wants the household code. Set ML_CODE.");
  if (!response.ok) fail(`GET ${url} failed: ${response.status}`);
  return response.json();
}

const health = await getJson("/api/health");
if (health.recogniser === "rehearsal") {
  fail("The server is in rehearsal mode (no vision model key), so there is nothing to measure.");
}
const keepsakes = await getJson("/api/keepsakes");
if (keepsakes.length === 0) fail("The server has no keepsakes. Add them in the family app first.");

// Work out what to send before sending anything, so a typo in a folder name costs nothing.
const jobs = [];
const keepsakesDir = path.join(folder, "keepsakes");
if (fs.existsSync(keepsakesDir)) {
  for (const name of fs.readdirSync(keepsakesDir).sort()) {
    const dir = path.join(keepsakesDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const wanted = name.trim().toLowerCase();
    const keepsake = keepsakes.find((k) => k.id.toLowerCase() === wanted || k.name.trim().toLowerCase() === wanted);
    if (!keepsake) {
      fail(
        `Folder "${name}" matches no keepsake on the server.\n` +
          `Keepsakes there: ${keepsakes.map((k) => `"${k.name}" (${k.id})`).join(", ")}`,
      );
    }
    for (const file of images(dir)) jobs.push({ file, expect: keepsake });
  }
}
for (const file of images(path.join(folder, "distractors"))) jobs.push({ file, expect: null });
if (jobs.length === 0) fail(`No usable images under ${folder}/keepsakes/<name>/ or ${folder}/distractors/.`);

const results = [];
let first = true;
for (const job of jobs) {
  const image = fs.readFileSync(job.file).toString("base64");
  for (let run = 1; run <= runs; run++) {
    if (!first) await sleep(GAP_MS);
    first = false;
    const started = Date.now();
    const result = { ...job, run };
    try {
      const response = await fetch(`${base}/api/recognise`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const body = await response.json().catch(() => ({}));
      result.ms = body.latencyMs ?? Date.now() - started;
      if (response.status === 403) fail("The wearer's consent is not recorded on this server, so it will not look.");
      if (response.ok) {
        result.matchId = body.matchId ?? null;
        result.label = body.objectLabel ?? "";
        result.reason = body.reason ?? "";
      } else {
        // The model was unavailable or too slow. To the wearer that is a failed look.
        result.error = body.error ?? `HTTP ${response.status}`;
      }
    } catch (error) {
      result.ms = Date.now() - started;
      result.error = error.message;
    }
    results.push(result);
    process.stderr.write(".");
  }
}
process.stderr.write("\n");

const nameOf = (id) => keepsakes.find((k) => k.id === id)?.name ?? id;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

console.log(`\n## Recognition scorecard\n`);
console.log(`Server ${base}, recogniser \`${health.recogniser}\`, ${runs} look(s) per image, ${new Date().toISOString()}\n`);
console.log("| Should be | Images | Looks | Correct | Wrong keepsake | Missed | Failed |");
console.log("|---|---|---|---|---|---|---|");

const wrong = [];
let falseMatches = 0;
const groups = new Map();
for (const r of results) {
  const key = r.expect ? r.expect.id : "";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
for (const [key, group] of groups) {
  const expectName = key ? nameOf(key) : "nothing (distractors)";
  let correct = 0;
  let wrongKeepsake = 0;
  let missed = 0;
  let failed = 0;
  for (const r of group) {
    const where = `${path.relative(folder, r.file)} (look ${r.run})`;
    if (r.error) {
      failed++;
      wrong.push(`${where}: no answer (${r.error})`);
    } else if (key && r.matchId === key) {
      correct++;
    } else if (!key && !r.matchId) {
      correct++;
    } else if (r.matchId) {
      wrongKeepsake++;
      if (!key) falseMatches++;
      wrong.push(`${where}: matched "${nameOf(r.matchId)}", should be ${expectName}. Model called it "${r.label}".`);
    } else {
      missed++;
      wrong.push(
        `${where}: not recognised, should be ${expectName}. Model called it "${r.label}"${r.reason ? ` (${r.reason})` : ""}.`,
      );
    }
  }
  const imageCount = new Set(group.map((r) => r.file)).size;
  console.log(
    `| ${expectName} | ${imageCount} | ${group.length} | ${correct} | ${wrongKeepsake} | ${key ? missed : "n/a"} | ${failed} |`,
  );
}

const times = results.filter((r) => !r.error && Number.isFinite(r.ms)).map((r) => r.ms).sort((a, b) => a - b);
console.log("");
if (times.length) {
  console.log(
    `Latency over ${times.length} answered look(s): median ${quantile(times, 0.5)} ms, p90 ${quantile(times, 0.9)} ms, max ${times[times.length - 1]} ms.`,
  );
} else {
  console.log("No look was answered, so there is no latency to report.");
}
console.log(`Distractors wrongly matched: ${falseMatches}.`);

if (wrong.length) {
  console.log("\n### Every wrong or failed look\n");
  for (const line of wrong) console.log(`- ${line}`);
} else {
  console.log("\nEvery look gave the expected result.");
}

process.exit(falseMatches > 0 ? 1 : 0);
