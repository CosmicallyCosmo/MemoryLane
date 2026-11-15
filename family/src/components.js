// Form pieces shared by the keepsake form and the answers form.
import { h, uid, icon, clear } from "./dom.js";
import { canRecordAudio, downscalePhoto, startAudioRecording } from "./media.js";

const formatClock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * Record in the browser, or choose an audio file. One recording at a time.
 * Returns { el, getFile(), setDisabled(), reset(), destroy() }.
 */
export function audioField({ legend, hint, baseName = "recording", optional = true }) {
  let file = null;
  let previewUrl = null;
  let recording = null;
  let timer = 0;

  const inputId = uid("audio");
  const body = h("div", { class: "audio-field__body" });
  const message = h("p", { class: "status", role: "status", "aria-live": "polite", hidden: true });
  const el = h(
    "fieldset",
    { class: "fieldset audio-field" },
    h(
      "legend",
      null,
      legend,
      optional ? h("span", { class: "field__optional" }, " (optional)") : null,
    ),
    hint ? h("p", { class: "field__hint" }, hint) : null,
    body,
    message,
  );

  const say = (text, isError = false) => {
    message.textContent = text ?? "";
    message.hidden = !text;
    message.classList.toggle("status--error", isError);
  };

  const dropPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  };

  function setFile(next) {
    dropPreview();
    file = next;
    render();
  }

  async function begin() {
    say("");
    try {
      recording = await startAudioRecording(baseName);
    } catch (error) {
      recording = null;
      say(error.message, true);
      render();
      return;
    }
    render();
    say("");
  }

  async function finish() {
    const current = recording;
    recording = null;
    clearInterval(timer);
    if (!current) return;
    try {
      const recorded = await current.stop();
      setFile(recorded);
      say("");
      body.querySelector("audio")?.focus();
    } catch (error) {
      say(error.message, true);
      render();
    }
  }

  function render() {
    clearInterval(timer);
    clear(body);

    if (recording) {
      const started = Date.now();
      const clock = h("span", { class: "audio-field__clock" }, "0:00");
      timer = setInterval(() => {
        clock.textContent = formatClock(Math.floor((Date.now() - started) / 1000));
      }, 500);
      const stop = h(
        "button",
        { type: "button", class: "btn btn--danger btn--big", onclick: finish },
        h("span", { class: "stop-square", "aria-hidden": "true" }),
        "Stop",
      );
      body.append(
        h(
          "div",
          { class: "audio-field__live" },
          h("span", { class: "rec-dot", "aria-hidden": "true" }),
          h("span", null, "Recording "),
          clock,
        ),
        stop,
      );
      stop.focus();
      return;
    }

    if (file) {
      previewUrl = URL.createObjectURL(file);
      body.append(
        h("audio", { controls: true, src: previewUrl, class: "audio-player", "aria-label": `${legend}: preview` }),
        h(
          "div",
          { class: "row" },
          canRecordAudio()
            ? h(
                "button",
                { type: "button", class: "btn", onclick: begin },
                icon("mic", 22),
                "Redo",
              )
            : null,
          h(
            "button",
            {
              type: "button",
              class: "btn",
              onclick: () => {
                setFile(null);
                say("Recording removed.");
              },
            },
            "Remove",
          ),
        ),
      );
      return;
    }

    const chooser = h("input", {
      type: "file",
      id: inputId,
      accept: "audio/*",
      class: "visually-hidden",
      onchange: (event) => {
        const chosen = event.target.files?.[0];
        if (!chosen) return;
        if (!chosen.type.startsWith("audio/")) {
          say("That isn't a sound file.", true);
          event.target.value = "";
          return;
        }
        say("");
        setFile(chosen);
      },
    });
    if (canRecordAudio()) {
      body.append(
        h("button", { type: "button", class: "btn btn--primary btn--big", onclick: begin }, icon("mic", 24), "Record"),
      );
    } else {
      body.append(
        h("p", { class: "field__hint" }, "This browser can't record. Choose a file instead."),
      );
    }
    body.append(h("label", { class: "file-link" }, "Or choose a file", chooser));
  }

  render();

  return {
    el,
    getFile: () => file,
    isRecording: () => Boolean(recording),
    setDisabled: (disabled) => {
      el.disabled = disabled;
    },
    reset() {
      recording?.cancel();
      recording = null;
      say("");
      setFile(null);
    },
    destroy() {
      clearInterval(timer);
      recording?.cancel();
      recording = null;
      dropPreview();
    },
  };
}

/**
 * Choose up to `max` photos. Each is shrunk in the browser as soon as it is chosen, and shown
 * as a thumbnail that can be removed. `onChange` runs whenever the photos chosen change.
 * Returns { el, getFiles(), whenReady(), reset(), destroy() }.
 */
export function photoPicker({ legend, hint, max, required = false, altPrefix = "Photo", onChange = () => {} }) {
  /** @type {{file: File, url: string}[]} */
  let photos = [];
  let pending = Promise.resolve();

  const inputId = uid("photos");
  const hintId = `${inputId}-hint`;
  const thumbs = h("ul", { class: "thumbs" });
  const count = h("p", { class: "field__hint thumbs__count" });
  const message = h("p", { class: "status", role: "status", "aria-live": "polite", hidden: true });
  const input = h("input", {
    type: "file",
    id: inputId,
    accept: "image/jpeg,image/png,image/webp,image/*",
    multiple: max > 1,
    class: "visually-hidden",
    "aria-describedby": hint ? hintId : null,
  });
  const addTile = h("label", { class: "add-tile" }, icon("camera", 32), h("span", null, max > 1 ? "Add photos" : "Add a photo"), input);

  const say = (text, isError = false) => {
    message.textContent = text ?? "";
    message.hidden = !text;
    message.classList.toggle("status--error", isError);
  };

  function render() {
    clear(thumbs);
    photos.forEach((photo, index) => {
      thumbs.append(
        h(
          "li",
          { class: "thumb" },
          h("img", { src: photo.url, alt: `${altPrefix} ${index + 1}`, class: "thumb__img" }),
          h(
            "button",
            {
              type: "button",
              class: "thumb__remove",
              "aria-label": `Remove ${altPrefix.toLowerCase()} ${index + 1}`,
              title: "Remove",
              onclick: () => {
                URL.revokeObjectURL(photo.url);
                photos = photos.filter((p) => p !== photo);
                render();
                say(`Photo removed. ${photos.length} of ${max} chosen.`);
                input.focus();
              },
            },
            icon("x", 18),
          ),
        ),
      );
    });
    thumbs.append(h("li", null, addTile));
    count.textContent = photos.length ? `${photos.length} of ${max}` : "";
    count.hidden = photos.length === 0;
    input.disabled = photos.length >= max;
    addTile.setAttribute("aria-disabled", String(input.disabled));
    if (required) input.setAttribute("aria-required", "true");
    onChange(photos.length);
  }

  input.addEventListener("change", () => {
    const chosen = [...(input.files ?? [])];
    input.value = "";
    if (!chosen.length) return;
    const room = max - photos.length;
    const taking = chosen.slice(0, room);
    const problems = [];
    if (chosen.length > room) {
      problems.push(`Only ${max} fit, so we kept the first ${room === 1 ? "one" : room}.`);
    }
    say("Getting them ready…");
    pending = pending.then(async () => {
      for (const original of taking) {
        try {
          const file = await downscalePhoto(original);
          photos.push({ file, url: URL.createObjectURL(file) });
        } catch (error) {
          problems.push(error.message);
        }
      }
      render();
      say(problems.join(" "), problems.length > 0);
    });
  });

  render();

  const el = h(
    "fieldset",
    { class: "fieldset photo-picker" },
    h(
      "legend",
      null,
      legend,
      required ? null : h("span", { class: "field__optional" }, " (optional)"),
    ),
    hint ? h("p", { class: "field__hint", id: hintId }, hint) : null,
    thumbs,
    count,
    message,
  );

  return {
    el,
    input,
    getFiles: () => photos.map((p) => p.file),
    whenReady: () => pending,
    reset() {
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      photos = [];
      say("");
      render();
    },
    destroy() {
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      photos = [];
    },
  };
}
