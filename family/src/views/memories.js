// Memories: a photo grid, and the form for adding one. A memory belongs to a thing the glasses
// can see, and has a voice message; photos or a video make it a memory lane too.
import { api } from "../api.js";
import { audioField, photoPicker } from "../components.js";
import { clear, emptyState, field, h, icon, loadInto, statusLine, uid } from "../dom.js";
import { state } from "../state.js";
import { more } from "../ui.js";

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

export function memoriesView({ params, onCleanup }) {
  return params.get("add") ? addView({ onCleanup }) : gridView();
}

/** One tile: the picture, the name and, if given, a line under it. Used here, on Home and on a profile. */
export function memoryTile(memory, caption = "") {
  // With Cloudinary: a frame it chose from the video, or the photo, cropped around what matters.
  const photo = memory.poster ?? memory.memoryPhotos[0] ?? memory.referencePhotos[0];
  return h(
    "li",
    null,
    h(
      "a",
      { class: "tile", href: `#/memories/${encodeURIComponent(memory.id)}` },
      h("span", { class: "tile__photo" }, photo ? h("img", { src: photo, alt: "", loading: "lazy" }) : null),
      h("span", { class: "tile__text" }, h("span", { class: "tile__name" }, memory.name), caption ? h("span", { class: "tile__caption" }, caption) : null),
    ),
  );
}

/** One line under a memory's tile: how the wearer has responded to it. */
function responseLine(memory) {
  if (!memory.plays && !memory.questions) return "Not opened yet";
  // Short: it sits on the photo.
  const parts = [];
  if (memory.plays) parts.push(memory.plays === 1 ? "Opened once" : `Opened ${memory.plays} times`);
  if (memory.unanswered) parts.push(memory.unanswered === 1 ? "1 question waiting" : `${memory.unanswered} questions waiting`);
  else if (memory.questions) parts.push(memory.questions === 1 ? "1 question" : `${memory.questions} questions`);
  if (memory.heart?.lastKind === "lifted") parts.push(memory.heart.simulated ? "Heart rate rose (simulated)" : "Heart rate rose");
  return parts.join(" · ");
}

function gridView() {
  const host = h("div", null);
  loadInto(host, () => api.stats(90), (stats) => {
    // In the order they were added, not by how often they are opened.
    const memories = [...stats.keepsakes].sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
    if (!memories.length) {
      host.append(
        emptyState({
          title: "No memories yet",
          body: "A photo of something they treasure, and your voice.",
          action: h("a", { class: "btn btn--primary btn--big", href: "#/memories?add=1" }, icon("plus", 24), "Add a memory"),
        }),
      );
      return;
    }
    host.append(h("ul", { class: "grid" }, memories.map((memory) => memoryTile(memory, stats.careSignals ? responseLine(memory) : ""))));
  });
  return h(
    "div",
    { class: "page" },
    h(
      "header",
      { class: "page-head" },
      h("h1", { tabindex: "-1" }, "Memories"),
      h("a", { class: "icon-btn icon-btn--filled", href: "#/memories?add=1", "aria-label": "Add a memory" }, icon("plus", 26)),
    ),
    host,
  );
}

// ---- Add a memory --------------------------------------------------------------------------
//
// In the order it comes together: the thing it belongs to, a message in your voice, then, if
// you like, photos or a video, which turn the message into a memory lane.

/** "4 photos and a video" */
function mediaWords(photos, video) {
  const parts = [];
  if (photos) parts.push(photos === 1 ? "1 photo" : `${photos} photos`);
  if (video) parts.push("a video");
  return parts.join(" and ");
}

function addView({ onCleanup }) {

  const name = h("input", { type: "text", maxLength: 80, required: true, autocomplete: "off" });
  const description = h("textarea", { rows: 2, maxLength: 400 });
  const from = h("input", { type: "text", maxLength: 60, autocomplete: "off", value: state.me?.name ?? "" });
  const introLine = h("input", { type: "text", maxLength: 200, autocomplete: "off" });
  const story = h("textarea", { rows: 3, maxLength: 1200 });
  const syncIntro = () => {
    const who = from.value.trim();
    introLine.placeholder = who ? `Here's a message ${who} recorded for you.` : "Here's a memory about this.";
  };
  from.addEventListener("input", syncIntro);
  syncIntro();

  // What it will be, said as it changes: just a voice, or a memory lane.
  let photoCount = 0;
  let clipFile = null;
  const summary = h("p", { class: "note", role: "status", "aria-live": "polite" });
  const updateSummary = () => {
    summary.textContent =
      photoCount || clipFile
        ? `Memory lane: ${mediaWords(photoCount, clipFile)} with your voice and music.`
        : "";
    summary.hidden = !summary.textContent;
  };

  const objectPhotos = photoPicker({
    legend: "The object",
    hint: "1 to 4 photos, from different sides.",
    max: 4,
    required: true,
    altPrefix: "Photo of the thing",
  });
  const voiceNote = audioField({
    legend: "Your message",
    hint: "“Do you remember when…”",
    baseName: "voice-note",
    optional: false,
  });
  const memoryPhotos = photoPicker({
    legend: "Photos",
    max: 6,
    altPrefix: "Photo",
    onChange: (count) => {
      photoCount = count;
      updateSummary();
    },
  });

  // Who appears in it: how the glasses can answer "who is that?".
  const inIt = new Set();
  const people = h(
    "fieldset",
    { class: "fieldset" },
    h("legend", null, "Who's in it?", h("span", { class: "field__optional" }, " (optional)")),
    state.members.map((member) =>
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", onchange: (event) => (event.target.checked ? inIt.add(member.id) : inIt.delete(member.id)) }),
        h("span", null, member.name),
      ),
    ),
  );

  const clipNote = h("p", { class: "status status--error", role: "status", "aria-live": "polite", hidden: true });
  const setClipNote = (text) => {
    clipNote.textContent = text ?? "";
    clipNote.hidden = !text;
  };
  const clip = h("input", {
    type: "file",
    accept: "video/*",
    class: "visually-hidden",
    id: uid("clip"),
    onchange: () => {
      clipFile = clip.files?.[0] ?? null;
      setClipNote("");
      if (clipFile && !clipFile.type.startsWith("video/")) {
        clipFile = null;
        clip.value = "";
        setClipNote("That isn't a video.");
      } else if (clipFile && clipFile.size > MAX_UPLOAD_BYTES) {
        clipFile = null;
        clip.value = "";
        setClipNote("Too long. A few minutes at most.");
      }
      clipName.textContent = clipFile ? clipFile.name : "Add a video";
      updateSummary();
    },
  });
  const clipName = h("span", null, "Add a video");
  updateSummary();

  const bringToLife = h(
    "div",
    { class: "fieldset" },
    memoryPhotos.el,
    h("div", null, h("label", { class: "btn", for: clip.id }, icon("film", 22), clipName), clip, h("span", { class: "field__optional" }, " (optional)"), clipNote),
    summary,
  );

  const consent = h("input", { type: "checkbox", id: uid("consent"), required: true });
  const errors = h("div", { class: "error-summary", role: "alert", tabindex: "-1", hidden: true });
  const status = statusLine();
  const progress = h("progress", { max: 1, value: 0, class: "progress", hidden: true, "aria-label": "Upload progress" });
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--big btn--block" }, "Save memory");
  const body = h("fieldset", { class: "form__body" });

  onCleanup(() => {
    objectPhotos.destroy();
    memoryPhotos.destroy();
    voiceNote.destroy();
  });

  function showErrors(problems) {
    clear(errors);
    for (const control of [name, objectPhotos.input, consent]) control.removeAttribute("aria-invalid");
    errors.hidden = problems.length === 0;
    if (!problems.length) return;
    errors.append(
      h(
        "ul",
        null,
        problems.map(({ message, control }) => {
          control?.setAttribute("aria-invalid", "true");
          return h("li", null, control ? h("a", { href: `#${control.id}`, onclick: (event) => (event.preventDefault(), control.focus()) }, message) : message);
        }),
      ),
    );
    errors.focus();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (submit.disabled) return;
    status.clear();
    await objectPhotos.whenReady();
    await memoryPhotos.whenReady();

    const problems = [];
    if (!objectPhotos.getFiles().length) problems.push({ message: "Add a photo of the object.", control: objectPhotos.input });
    if (voiceNote.isRecording()) problems.push({ message: "Stop recording first.", control: null });
    else if (!voiceNote.getFile()) problems.push({ message: "Record your message.", control: null });
    else if (voiceNote.getFile().size > MAX_UPLOAD_BYTES) problems.push({ message: "Message too long. A few minutes at most.", control: null });
    if (!name.value.trim()) problems.push({ message: "Give it a name.", control: name });
    if (!consent.checked) problems.push({ message: "Tick the consent box.", control: consent });
    showErrors(problems);
    if (problems.length) return;

    const lane = Boolean(memoryPhotos.getFiles().length || clipFile);
    submit.disabled = true;
    body.disabled = true;
    try {
      status.set("Uploading… 0%");
      progress.hidden = false;
      progress.value = 0;
      const saved = await api.createKeepsake(
        {
          name: name.value.trim(),
          description: description.value.trim(),
          from: from.value.trim(),
          introLine: introLine.value.trim(),
          story: story.value.trim(),
          referencePhotos: objectPhotos.getFiles(),
          memoryPhotos: memoryPhotos.getFiles(),
          voiceNote: voiceNote.getFile(),
          clip: clipFile,
          consentConfirmed: consent.checked,
          addedBy: state.me?.id,
          people: [...inIt],
        },
        (fraction) => {
          progress.value = fraction;
          status.set(
            fraction < 1
              ? `Uploading… ${Math.round(fraction * 100)}%`
              : lane
                ? "Making your memory lane. This can take a minute…"
                : "Nearly done…",
          );
        },
      );
      window.location.hash = `#/memories/${encodeURIComponent(saved.id)}${saved.lane ? "?new=1" : ""}`;
    } catch (error) {
      status.clear();
      showErrors([{ message: error.message, control: /name/i.test(error.message) ? name : /agreed|included/i.test(error.message) ? consent : null }]);
    } finally {
      progress.hidden = true;
      submit.disabled = false;
      body.disabled = false;
    }
  }

  body.append(
    objectPhotos.el,
    voiceNote.el,
    bringToLife,
    field({ label: "Name", control: name }),
    more("More details", () => [
      state.members.length ? people : null,
      field({ label: "Describe the object", hint: "Colour, shape, markings.", control: description, optional: true }),
      field({ label: "The story", hint: "Shown on the glasses.", control: story, optional: true }),
      field({ label: "From", control: from, optional: true }),
      field({ label: "First words", control: introLine, optional: true }),
    ]),
    h("label", { class: "check", for: consent.id }, consent, h("span", null, "Everyone in it is happy to be included.")),
  );

  return h(
    "div",
    { class: "page" },
    h("h1", { tabindex: "-1" }, "New memory"),
    h("form", { class: "form", novalidate: true, onsubmit: onSubmit }, errors, body, status.el, progress, submit),
  );
}
