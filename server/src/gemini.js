// Gemini as the model behind the same two choices (which keepsake, which recorded answer).
// Plain REST: one endpoint, JSON in, schema-constrained JSON out.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// Tried in turn. Measured on the free tier on 14 Nov 2026 with two keepsakes: 3.5 Flash-Lite
// answered a look in 2 to 5 s, but about one call in ten got a 503 or no reply at all. 3.1
// Flash-Lite is the one other model that answered in time; the larger Flash models took 20 s
// or more. (gemini-flash-lite-latest is the same model as 3.5 Flash-Lite, so not a fallback.)
const MODELS = (process.env.ML_GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const endpoint = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const geminiModel = () => MODELS.join(", then ");

function inlineImage(file, mediaDir) {
  const data = fs.readFileSync(path.join(mediaDir, path.basename(file)));
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { mimeType, data: data.toString("base64") };
}

// A reference photo is sent on every look, so it is sent small: 512 px on the long side, JPEG.
// Measured 15 Nov 2026 on the recordings household (13 photos): a look went from 2.7 MB and
// 2.2 s to 0.7 MB and 1.0 s, with no real object missed. The original stays on disk as it was
// uploaded; the small copy is made once per photo and kept in memory.
const SEND_EDGE = 512;
const sendCopies = new Map();

async function referenceImage(file, mediaDir) {
  const full = path.join(mediaDir, path.basename(file));
  let copy = sendCopies.get(full);
  if (!copy) {
    try {
      const data = await sharp(full)
        .rotate()
        .resize(SEND_EDGE, SEND_EDGE, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      copy = { mimeType: "image/jpeg", data: data.toString("base64") };
    } catch (error) {
      // A photo that cannot be decoded here is sent as it is, as before.
      console.warn(`could not make a small copy of ${path.basename(file)}: ${error?.message ?? error}`);
      copy = inlineImage(file, mediaDir);
    }
    sendCopies.set(full, copy);
  }
  return copy;
}

const MEDIA_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
};

/** A stored photo or recording as an inline part, or null for a type Gemini is not sent. */
export function inlineMedia(file, mediaDir) {
  const mimeType = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!mimeType) return null;
  const data = fs.readFileSync(path.join(mediaDir, path.basename(file)));
  return { inlineData: { mimeType, data: data.toString("base64") } };
}

/** Schema-constrained JSON from the first model that answers in time. */
export function geminiJson(options) {
  return generate(options);
}

/**
 * Tries the models in turn until one answers or the time is up. A busy model answers 503 or
 * not at all, and the next try usually works, so a call that expects a quick answer passes a
 * short attemptMs and gets several tries instead of one long wait.
 *
 * thinking is the model's thinking level. Left to the model's own default, a call with a few
 * photos took about 12.5 s on every model tried (15 Nov 2026), and many ran out of time;
 * "minimal" answered the same calls in about 4 s, all of them right. 3.8 Flash and 4 Hydrogen
 * accept "low" at the least, so they need it passed if ML_GEMINI_MODEL names them.
 */
async function generate({ system, parts, schema, timeoutMs, attemptMs = timeoutMs, maxOutputTokens = 2000, thinking = "minimal" }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    // No answer has ever come back in under a second and a half.
    if (remaining < 1500) break;
    const model = MODELS[attempt % MODELS.length];
    // A whole number: AbortSignal.timeout throws on a fraction.
    const budget = Math.floor(Math.min(remaining, attemptMs));
    try {
      const response = await fetch(endpoint(model), {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(budget),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
            temperature: 0,
            maxOutputTokens,
            thinkingConfig: { thinkingLevel: thinking },
          },
        }),
      });
      if (!response.ok) {
        const error = new Error(`Gemini ${model} ${response.status}: ${(await response.text()).slice(0, 200)}`);
        // A bad request (an unreadable image, a wrong key) fails the same way every time.
        error.final = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw error;
      }
      const body = await response.json();
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      // A blocked or empty reply is treated by the caller as "could not decide".
      return text ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      console.warn(`${model}: ${error?.message ?? error}`);
      if (error.final) break;
      // A request that fails at once (no network) is not sent again straight away.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("Gemini: out of time");
}

export async function geminiRecognise({ system, frameBase64, keepsakes, mediaDir, timeoutMs }) {
  const parts = [];
  for (const keepsake of keepsakes) {
    parts.push({ text: `Keepsake id "${keepsake.id}": ${keepsake.name}. ${keepsake.description || ""}`.trim() });
    for (const photo of keepsake.referencePhotos) parts.push({ inlineData: await referenceImage(photo, mediaDir) });
  }
  parts.push({ text: "That is the whole list. This is the frame from the glasses:" });
  parts.push({ inlineData: { mimeType: "image/jpeg", data: frameBase64 } });
  return generate({
    system,
    parts,
    timeoutMs,
    attemptMs: 6000,
    schema: {
      type: "OBJECT",
      properties: {
        match_id: { type: "STRING", description: 'A keepsake id from the list, or "none"' },
        confidence: { type: "NUMBER", description: "0 to 1" },
        object_label: { type: "STRING" },
      },
      required: ["match_id", "confidence", "object_label"],
    },
  });
}

const DESCRIBE_SYSTEM = `You write the identifying features of one specific physical object, from photos of it. A later check uses them, beside these photos, to decide whether a new photo shows this exact object or a different object of the same kind, so they must hold under different lighting, angle, distance and blur.

Start with what kind of object it is in a few words. Then be specific, with counts and positions: shape and proportions; the pictures, patterns or design on it and their layout; any printed or written text, exactly; the number and arrangement of parts (for example "three brass buttons in a vertical line down the front"); materials (opaque or see-through, matt or shiny); lasting marks such as wear or damage. Leave out what changes with the light or the setting: exact shades, glare, colour casts, the background. For a photograph or a card with people in it, give its layout: how many people, where they stand, their clothing and poses, the setting; never who they are or what they look like facially. 60 to 110 words.

Then, as checks, 4 to 7 short statements, each true of this object and likely false of a look-alike (another candle, another card with roses, another graduation photograph): a shape, a count, a layout, printed text, which way something faces, what is see-through, the people's positions and clothing in a photograph. Only what stays true under other lighting and blur and shows from the front. Write only what the photos show; leave out anything unsure.`;

/**
 * The features that tell this keepsake apart from others of its kind, and checks to confirm a
 * match by, written once from its full-size photos so that what a small copy loses is still
 * said. Empty if none came back.
 */
export async function geminiDescribeKeepsake({ keepsake, mediaDir, timeoutMs = 60000 }) {
  const parts = [
    { text: `The family calls it "${keepsake.name}". ${keepsake.description || ""}`.trim() },
    ...keepsake.referencePhotos.map((photo) => inlineMedia(photo, mediaDir)).filter(Boolean),
  ];
  const parsed = await generate({
    system: DESCRIBE_SYSTEM,
    parts,
    timeoutMs,
    attemptMs: 20000,
    schema: {
      type: "OBJECT",
      properties: { features: { type: "STRING" }, checks: { type: "ARRAY", items: { type: "STRING" } } },
      required: ["features", "checks"],
    },
  });
  return {
    features: String(parsed?.features ?? "").trim().slice(0, 1200),
    checks: (Array.isArray(parsed?.checks) ? parsed.checks : [])
      .map((check) => String(check).trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 7),
  };
}

/**
 * The second look at a match: this keepsake's photos and the frame, nothing else, asked "the
 * same object, or another of its kind?" and each of its checks. Measured 15 Nov 2026 on 18 real
 * looks and 22 look-alikes and unknown objects: real looks scored 0.83 to 0.97 for "same", every
 * look-alike that got past the choice 0.42 or less, and none of them a clear "no" on a check
 * below 0.28. A choice among several keepsakes lets the closest win; compared with one, the model
 * looks for what differs.
 */
export async function geminiConfirmKeepsake({ keepsake, frameBase64, mediaDir, timeoutMs }) {
  const input = [{ type: "text", text: `Reference photos of one specific object, "${keepsake.name}":\n` }];
  for (const photo of keepsake.referencePhotos) {
    const { mimeType, data } = await referenceImage(photo, mediaDir);
    input.push({ type: "image", data, mime_type: mimeType });
  }
  const features = [keepsake.description, keepsake.features].filter(Boolean).join(" ");
  input.push(
    {
      type: "text",
      text:
        (features ? `\nIts identifying features: ${features}\n` : "\n") +
        "\nA new photo, from camera glasses. Lighting, colour cast, angle, distance and blur may differ from the reference photos:\n",
    },
    { type: "image", data: frameBase64, mime_type: "image/jpeg" },
  );
  const questions = {
    same: {
      type: "choice",
      instructions: "Is the main object in the new photo this exact physical object, or a different object of the same kind?",
      criteria: {
        same: "The same physical object as in the reference photos: every visible feature agrees, allowing for light, angle and blur.",
        different:
          "A different object of the same kind: at least one visible feature differs (design, layout, shape, text, number or direction of parts, see-through or not, different people).",
      },
    },
  };
  (keepsake.checks ?? []).forEach((check, i) => {
    questions[`check${i}`] = {
      type: "choice",
      instructions: `Look only at the main object in the new photo. Check: "${check}"`,
      criteria: {
        yes: "This is clearly true of the main object in the new photo.",
        no: "This is clearly not true of it: that part looks different (shape, count, layout, text, direction, material or people).",
        unseen: "That part cannot be seen in the new photo: hidden, out of frame or too blurred to tell.",
      },
    };
  });
  const answers = await decisions({ input, questions }, timeoutMs);
  if (!answers) return null;
  const noes = Object.entries(answers)
    .filter(([key]) => key.startsWith("check"))
    .map(([, answer]) => answer?.probabilities?.no ?? 0);
  return { same: answers.same?.probabilities?.same ?? 0, worstNo: Math.max(0, ...noes) };
}

// Pictures of other objects that could be taken for a keepsake, for its self-test. Made by
// editing its own photo, so they share its kind, colours and setting and differ in a detail.
const IMAGE_MODEL = process.env.ML_GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
const LOOKALIKE_ASKS = [
  "Make a realistic photo of a different object of the same kind, one that someone could mistake for this one at a glance: same kind of object and a similar style and colours, but clearly different in one or two identifying details (its design, a pattern, printed text, the number or shape of its parts, or, in a photograph or card, different people). An ordinary home, everyday light, a slightly different angle.",
  "Make a realistic photo of another object that is sold or made looking much like this one, in a different home: the same kind and general look, but not this one, with at least one identifying detail different. If it is a photograph or card with people in it, show different people in a similar scene.",
];

/** Two look-alike pictures (base64 JPEG), or fewer if the image model gave fewer. */
export async function geminiImagineLookalikes({ keepsake, mediaDir, timeoutMs = 60000 }) {
  const photo = inlineMedia(keepsake.referencePhotos[0], mediaDir);
  const made = await Promise.all(
    LOOKALIKE_ASKS.map(async (ask) => {
      try {
        const response = await fetch(endpoint(IMAGE_MODEL), {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [photo, { text: ask }] }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
        });
        if (!response.ok) throw new Error(`${IMAGE_MODEL} ${response.status}: ${(await response.text()).slice(0, 200)}`);
        const body = await response.json();
        const data = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData?.data;
        if (!data) return null;
        // As a frame from the glasses would come: a JPEG of about their size.
        const frame = await sharp(Buffer.from(data, "base64"))
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        return frame.toString("base64");
      } catch (error) {
        console.warn(`look-alike of "${keepsake.name}": ${error?.message ?? error}`);
        return null;
      }
    }),
  );
  return made.filter(Boolean);
}

// The Decisions API (gemini-decision-1, November 2026) answers a closed choice with a
// probability for each option and writes no text, which is exactly the shape of "which keepsake
// is this?". It is the recogniser whenever Gemini is; ML_GEMINI_DECISIONS=0 goes back to Gemini
// vision. It cannot name an object that holds no memory, so on a miss the caller asks
// geminiRecognise for the label.
export const decisionsEnabled = () => process.env.ML_GEMINI_DECISIONS !== "0";
const DECISIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/decisions";
// The catch-all option. Keepsake ids start "k_", so it cannot clash with one. (An exact tie goes
// to the alphabetically first key, a keepsake, but at 0.5 that is still below the threshold.)
const NO_MATCH = "other";

/** The answers to a Decisions request, or null for a frame it would not look at. */
async function decisions({ input, questions }, timeoutMs) {
  const response = await fetch(DECISIONS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    // A whole number: AbortSignal.timeout throws on a fraction.
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    body: JSON.stringify({ model: "gemini-decision-1", input, questions }),
  });
  const body = await response.json().catch(() => ({}));
  // A blocked frame is a 400 with a safety code: treated by the caller as "could not decide".
  if (response.status === 400 && body.error?.code) return null;
  if (!response.ok) throw new Error(`Gemini Decisions ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.answers ?? null;
}

/**
 * Same result shape as geminiRecognise: { match_id, confidence, object_label }.
 *
 * The model never sees the option keys, so each keepsake is a numbered option whose name,
 * features and photos sit together, and its criterion points back to "the photos under option
 * N". Measured 15 Nov 2026: with photos tied only by name, a different family's graduation
 * photograph (same layout, different people) matched at 0.88; numbered this way, under 0.2.
 */
export async function geminiDecideKeepsake({ frameBase64, keepsakes, mediaDir, timeoutMs }) {
  const input = [
    {
      type: "text",
      text: `The family has registered ${keepsakes.length} keepsakes, numbered as options. Each option gives the keepsake's name, its identifying features when known, and reference photos of that one physical object.\n`,
    },
  ];
  const criteria = {};
  for (const [index, keepsake] of keepsakes.entries()) {
    const n = index + 1;
    const features = [keepsake.description, keepsake.features].filter(Boolean).join(" ");
    input.push({
      type: "text",
      text:
        `\nOption ${n}: "${keepsake.name}".\n` +
        (features ? `Identifying features of option ${n}: ${features}\n` : "") +
        `Reference photos of option ${n} ("${keepsake.name}"):\n`,
    });
    for (const photo of keepsake.referencePhotos) {
      const { mimeType, data } = await referenceImage(photo, mediaDir);
      input.push({ type: "image", data, mime_type: mimeType });
    }
    input.push({ type: "text", text: `End of option ${n}.\n` });
    criteria[keepsake.id] =
      `Option ${n}, "${keepsake.name}": the main object in the last image is this exact object, the one in the reference photos under option ${n}. ` +
      `Lighting, colour cast, angle, distance, blur and background may all differ. ` +
      (features
        ? `Every identifying feature that can be seen must agree with the photos under option ${n}: ${features} `
        : `Every identifying feature that can be seen must agree with the photos under option ${n}. `) +
      "One clearly different feature (shape, design, layout, printed text, number or arrangement of parts, or, for a photograph or card, different people, poses or clothing) means it is not this object.";
  }
  criteria[NO_MATCH] =
    "None of the options: the main object differs in at least one identifying feature from every option's reference photos, even if it is the same kind of object with similar colours or a similar scene; or it is a person; or there is no clear object.";
  input.push({ type: "text", text: "\n\nThe frame from the glasses:\n" });
  input.push({ type: "image", data: frameBase64, mime_type: "image/jpeg" });

  const answers = await decisions(
    {
      input,
      questions: {
        keepsake: {
          type: "choice",
          instructions:
            "The last image is a frame from camera glasses worn by a person living with memory loss. " +
            "Is the main object in it, the one held or looked at most directly, exactly one of the numbered options? " +
            "Compare it with that option's own reference photos and identifying features, feature by feature. " +
            "A change of light or angle is the same object; a different design, layout, text or different people is a different object.",
          criteria,
        },
      },
    },
    timeoutMs,
  );
  const answer = answers?.keepsake;
  if (!answer?.choice) return null;
  const keepsake = keepsakes.find((k) => k.id === answer.choice);
  return {
    match_id: keepsake ? keepsake.id : "none",
    confidence: answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0,
    // No label here: this model writes no text, and a miss must not be described with a
    // keepsake's name ("It looks like Mum's teapot" while saying there is no memory).
    object_label: "",
  };
}

export async function geminiChooseAnswer({ system, prompt, timeoutMs }) {
  return generate({
    system,
    parts: [{ text: prompt }],
    timeoutMs,
    attemptMs: 4000,
    schema: {
      type: "OBJECT",
      properties: { answer_id: { type: "STRING", description: 'A recorded answer id, or "none"' } },
      required: ["answer_id"],
    },
  });
}
