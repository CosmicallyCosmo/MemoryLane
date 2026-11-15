// The few building blocks every page shares. Kept deliberately small: a link that opens a
// little more, a row that opens, the answer form, and "ask someone else".
import { api } from "./api.js";
import { audioField } from "./components.js";
import { avatar, h, icon, modal, statusLine } from "./dom.js";
import { state } from "./state.js";

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

/** A text link that reveals more underneath: "How this works", "More details", "Edit". */
export function more(label, build, { quiet = false, open = false } = {}) {
  const body = h("div", { class: "more__body" });
  let built = false;
  const el = h("details", { class: `more ${quiet ? "more--quiet" : ""}`.trim(), open }, h("summary", null, label), body);
  const fill = () => {
    if (built) return;
    built = true;
    body.append(...[build()].flat().filter(Boolean));
  };
  el.addEventListener("toggle", () => el.open && fill());
  if (open) fill();
  return el;
}

/**
 * Shows only the first `count` rows of a filled list, with a "Show N more" button for the rest.
 * `el` is the button to put after the list (null when every row fits); `reveal(row)` shows them
 * all, as when a link points at a row further down.
 */
export function showFirst(list, count = 3) {
  const rest = [...list.children].slice(count);
  if (!rest.length) return { el: null, reveal: () => {} };
  for (const row of rest) {
    row.hidden = true;
    row.classList.add("appear");
  }
  const el = h("button", { type: "button", class: "link show-more" }, `Show ${rest.length} more`);
  const reveal = () => {
    for (const row of rest) row.hidden = false;
    el.remove();
  };
  el.addEventListener("click", () => {
    reveal();
    // The button is gone: carry on from the first row it showed.
    rest[0].querySelector("a, button, summary")?.focus();
  });
  return { el, reveal };
}

/** A list row that opens in place. `summary` is the row; `build` makes what is underneath. */
export function fold(summary, build) {
  const body = h("div", { class: "item__open" });
  let built = false;
  const el = h("details", { class: "fold" }, h("summary", { class: "item" }, summary, icon("chevron", 20)), body);
  el.addEventListener("toggle", () => {
    if (!el.open || built) return;
    built = true;
    body.append(...[build()].flat().filter(Boolean));
  });
  return el;
}

/** Lets one relative ask another to record an answer. Resolves to a sentence, or null. */
export function askSomeone({ keepsakeId, question }) {
  const others = state.members.filter((m) => m.id !== state.me?.id);
  return modal({
    title: "Who would you like to ask?",
    build: (close) => {
      const status = statusLine();
      if (!others.length) {
        return h(
          "div",
          null,
          h("p", { class: "dialog__body" }, "Nobody else has joined yet."),
          h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", onclick: () => close(null) }, "Close")),
        );
      }
      return h(
        "div",
        null,
        h("p", { class: "dialog__body" }, `“${question}”`),
        h(
          "ul",
          { class: "list", style: "margin-top:16px" },
          others.map((member) =>
            h(
              "li",
              null,
              h(
                "button",
                {
                  type: "button",
                  class: "item link",
                  style: "width:100%;text-decoration:none;text-align:left;min-height:60px",
                  onclick: async (event) => {
                    event.currentTarget.disabled = true;
                    try {
                      const result = await api.requestAnswer({ forMember: member.id, fromMember: state.me?.id, keepsakeId: keepsakeId ?? undefined, question });
                      close(result.sent ? `Asked ${member.name}.` : `${member.name} was already asked.`);
                    } catch (error) {
                      event.currentTarget.disabled = false;
                      status.error(error.message);
                    }
                  },
                },
                avatar(member, "lg"),
                h("span", { class: "item__main" }, h("span", { class: "item__title item__title--plain", style: "display:block" }, member.name), h("span", { class: "item__meta" }, member.relationship || "")),
              ),
            ),
          ),
        ),
        status.el,
        h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", onclick: () => close(null) }, "Cancel")),
      );
    },
  });
}

/**
 * One answer: a recording, some words, or both, then Save.
 * With `question` given, that is the question being answered. Without it, the question is typed.
 * `memory` set means the answer belongs to that memory; otherwise it is an everyday answer.
 */
export function answerForm({ question, memory, onSaved, onAsked, onCancel, onCleanup }) {
  const status = statusLine();
  const questionInput = h("input", { type: "text", maxLength: 200, autocomplete: "off", value: question ?? "" });
  const text = h("textarea", { rows: 2, maxLength: 600, "aria-label": "Your answer, in writing", placeholder: "Or type it" });
  const audio = audioField({ legend: "Your answer", baseName: "answer", optional: false });
  onCleanup?.(() => audio.destroy());
  const save = h("button", { type: "submit", class: "btn btn--primary btn--block" }, "Save");

  // Questions families often answer ahead of time. Tapping one fills it in.
  const starters = h(
    "div",
    { class: "chips", style: "margin-top:4px" },
    STARTER_QUESTIONS.map((q) =>
      h(
        "button",
        {
          type: "button",
          class: "chip",
          onclick: () => {
            questionInput.value = q;
            questionInput.focus();
            const gap = q.indexOf("…");
            if (gap >= 0) questionInput.setSelectionRange(gap, gap + 1);
          },
        },
        q,
      ),
    ),
  );

  const el = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (save.disabled) return;
        status.clear();
        const q = questionInput.value.trim();
        const words = text.value.trim();
        questionInput.removeAttribute("aria-invalid");
        text.removeAttribute("aria-invalid");
        if (!q || q.includes("…")) {
          questionInput.setAttribute("aria-invalid", "true");
          status.error(q ? "Put a name where the … is." : "Type the question.");
          questionInput.focus();
          return;
        }
        if (audio.isRecording()) return status.error("Stop recording first.");
        const recording = audio.getFile();
        if (!words && !recording) {
          text.setAttribute("aria-invalid", "true");
          status.error("Record or type an answer.");
          text.focus();
          return;
        }
        if (recording && recording.size > MAX_UPLOAD_BYTES) return status.error("Too long. Keep it under a few minutes.");
        save.disabled = true;
        status.set("Saving…");
        try {
          const body = { question: q, text: words, speaker: state.me?.name ?? "", audio: recording, addedBy: state.me?.id };
          if (memory) await api.addAnswer(memory.id, body);
          else await api.addQuestionAnswer(body);
          audio.destroy();
          onSaved(q);
        } catch (error) {
          save.disabled = false;
          status.error(error.message);
        }
      },
    },
    question
      ? null
      : h(
          "div",
          { class: "field" },
          h("label", { class: "field__label", for: (questionInput.id = `q-${Math.random().toString(36).slice(2, 8)}`) }, "The question"),
          starters,
          questionInput,
        ),
    audio.el,
    text,
    status.el,
    save,
    h(
      "div",
      { class: "row", style: "justify-content:center" },
      onCancel ? h("button", { type: "button", class: "link link--quiet", onclick: onCancel }, "Cancel") : null,
      question && onAsked
        ? h(
            "button",
            {
              type: "button",
              class: "link link--quiet",
              onclick: async () => {
                const result = await askSomeone({ keepsakeId: memory?.id, question });
                if (result) onAsked(result);
              },
            },
            "Ask someone else",
          )
        : null,
    ),
  );
  return { el, questionInput, text };
}

/** A recorded or written answer, shown when its row is opened. */
export function answerBody(answer, { onDelete }) {
  return [
    answer.text ? h("p", null, answer.text) : null,
    answer.audio ? h("audio", { controls: true, preload: "none", src: answer.audio, class: "audio-player", "aria-label": `Recorded answer to: ${answer.question}` }) : null,
    h("button", { type: "button", class: "link link--danger small", onclick: onDelete }, "Delete"),
  ];
}

/** What people living with memory loss often ask. "…" is a gap for a name. */
const STARTER_QUESTIONS = ["Where is …?", "Where am I?", "When are you coming?", "Who's coming today?", "What day is it?"];

const RELATIONSHIPS = ["Daughter", "Son", "Wife", "Husband", "Partner", "Grandchild", "Sister", "Brother", "Friend", "Carer"];

/**
 * "How are you related?" as a row of choices, with "Something else" opening a text box.
 * `value()` is what was chosen or typed; empty if nothing was.
 */
export function relationshipPicker({ initial = "", legend }) {
  const custom = h("input", { type: "text", maxLength: 60, autocomplete: "off", "aria-label": "How you are related", placeholder: "Niece, neighbour…" });
  const known = RELATIONSHIPS.find((r) => r.toLowerCase() === initial.toLowerCase());
  let chosen = known ?? (initial ? "other" : "");
  if (chosen === "other") custom.value = initial;
  const chips = [...RELATIONSHIPS, "Something else"].map((label) => {
    const value = label === "Something else" ? "other" : label;
    return h("button", { type: "button", class: "chip", "aria-pressed": String(value === chosen), dataset: { value } }, label);
  });
  const sync = () => {
    for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.value === chosen));
    custom.hidden = chosen !== "other";
  };
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      chosen = chosen === chip.dataset.value ? "" : chip.dataset.value;
      sync();
      if (chosen === "other") custom.focus();
    });
  }
  sync();
  return {
    el: h("fieldset", { class: "fieldset" }, h("legend", null, legend, h("span", { class: "field__optional" }, " (optional)")), h("div", { class: "chips" }, chips), custom),
    value: () => (chosen === "other" ? custom.value.trim() : chosen),
  };
}
