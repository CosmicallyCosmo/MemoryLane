// Puts a folder of clips into someone's memory lane, through the running server (so they go to
// Cloudinary when it is set up). The folder is the one the walk-through was built in: a
// memories.js naming each clip's year, title and file, with the files beside it.
//
//   node scripts/seed-lane.mjs                       # ../lane, onto the person called in memories.js
//   node scripts/seed-lane.mjs --name Jake --limit 3 --server http://127.0.0.1:8795
//
// It adds only moments that are not there yet (same year and title), so it can be run again.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const SERVER = option("server", "http://127.0.0.1:8787").replace(/\/$/, "");
const DIR = path.resolve(option("dir", fileURLToPath(new URL("../../lane", import.meta.url))));
const LIMIT = Number(option("limit", "0"));
const headers = process.env.ML_CODE ? { "x-memorylane-code": process.env.ML_CODE } : {};

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(DIR, "memories.js"), "utf8"), sandbox);
const lane = sandbox.window.MEMORY_LANE;
const wanted = option("name", lane.name).toLowerCase();

const members = await (await fetch(`${SERVER}/api/members`, { headers })).json();
const member = members.find((m) => m.name.toLowerCase() === wanted) ?? members.find((m) => m.name.toLowerCase().split(/\s+/)[0] === wanted);
if (!member) {
  console.error(`Nobody called "${wanted}" in the family at ${SERVER}. People there: ${members.map((m) => m.name).join(", ") || "none"}.`);
  process.exit(1);
}

const existing = await (await fetch(`${SERVER}/api/members/${member.id}/lane`, { headers })).json();
const have = new Set(existing.memories.map((m) => `${m.year}|${m.title}`));
const moments = LIMIT ? lane.memories.slice(0, LIMIT) : lane.memories;
let added = 0;
for (const moment of moments) {
  if (have.has(`${moment.year}|${moment.title}`)) continue;
  const file = path.join(DIR, moment.src);
  if (!fs.existsSync(file)) {
    console.warn(`Missing ${moment.src}, skipped.`);
    continue;
  }
  const form = new FormData();
  form.append("video", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), path.basename(file));
  form.append("year", String(moment.year));
  form.append("title", moment.title);
  const response = await fetch(`${SERVER}/api/members/${member.id}/lane`, { method: "POST", body: form, headers });
  if (!response.ok) {
    console.error(`${moment.year} ${moment.title}: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  const saved = await response.json();
  const clip = saved.memories.find((m) => m.year === moment.year && m.title === moment.title);
  console.log(`${moment.year}  ${moment.title}  ->  ${clip.src.startsWith("http") ? "Cloudinary" : "this server"}`);
  added++;
}
console.log(`${member.name}'s memory lane: ${added} added, ${existing.memories.length + added} in all.`);
console.log(`${SERVER}/lane/${member.id}/memory-lane.html`);
