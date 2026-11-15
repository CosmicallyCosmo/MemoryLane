import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiMode } from "./ai.js";
import { createApp } from "./app.js";
import { cloudinaryEnabled, publishLensCopies } from "./cloudinary.js";
import { decisionsEnabled, geminiModel } from "./gemini.js";
import { createStore } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore(process.env.ML_DATA_DIR || path.join(root, "data"));
const app = createApp({ store, familyDist: path.resolve(root, "../family/dist") });
const port = Number(process.env.PORT || 8787);

app.listen(port, "0.0.0.0", () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => `http://${n.address}:${port}`);
  console.log(`Memory Lane server on http://localhost:${port}`);
  if (lan.length) console.log(`On this network: ${lan.join("  ")}`);
  console.log("Phone over USB: adb reverse tcp:8787 tcp:8787");
  console.log(
    {
      gemini: decisionsEnabled()
        ? `Recogniser: Gemini Decisions API (gemini-decision-1); features and misses named by ${geminiModel()}.`
        : `Recogniser: Gemini vision (${geminiModel()}).`,
      rehearsal: "Recogniser: rehearsal mode (no model key). The phone names the keepsake.",
    }[aiMode()],
  );
  if (cloudinaryEnabled()) {
    console.log("Glasses films are made and served by Cloudinary.");
    publishLensCopies(store)
      .then((moved) => moved && console.log(`Moved ${moved} glasses film(s) to Cloudinary.`))
      // Whatever has no up-to-date glasses copy gets one now, with nobody's page open.
      .then(() => {
        const started = app.locals.films.catchUp();
        if (started) console.log(`Cloudinary is making ${started} glasses film(s).`);
      });
  }
});
