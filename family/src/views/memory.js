// One memory: what is seen and heard, then the questions about it, then a quiet way to edit.
import { api } from "../api.js";
import { heartChart } from "../charts.js";
import { clear, confirmDialog, field, formatDate, formatTime, h, loadInto, statusLine } from "../dom.js";
import { stillWaiting } from "../match.js";
import { loadMembers, refreshOpenQuestions, state } from "../state.js";
import { answerBody, answerForm, fold, more, showFirst } from "../ui.js";
import { photoPicker } from "../components.js";
import { lanePanel } from "./lane.js";

const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

const stamp = (at) => `${formatDate(at, { day: "numeric", month: "short" })}, ${formatTime(at)}`;

/** The latest time as a chart with its sentence, the times before it as a list, and what is usual. */
function heartSection(heart, wearerName) {
  const section = h("section", { class: "section" }, h("h2", null, wearerName ? `${wearerName}'s heart rate` : "Their heart rate"));
  if (!heart?.enabled) {
    section.append(h("p", { class: "muted" }, "Heart rate isn't being noted. You can switch it on under ", h("a", { href: "#/consent" }, "Privacy"), "."));
    return section;
  }
  const [latest, ...earlier] = heart.sessions;
  if (!latest) {
    section.append(h("p", { class: "muted" }, "Nothing yet. It's noted only while this memory is open."));
    return section;
  }
  const { typical } = heart;
  if (typical.sessions > 1) {
    section.append(
      h(
        "p",
        { class: "lede" },
        typical.lifted
          ? `It rose ${typical.lifted} of the ${typical.sessions} times this was open, by about ${typical.averageRise} beats a minute.`
          : typical.settled
            ? `It fell ${typical.settled} of the ${typical.sessions} times this was open.`
            : `It stayed close to resting each of the ${typical.sessions} times this was open.`,
      ),
    );
  }
  section.append(
    h(
      "div",
      { class: "heart" },
      h("p", { class: "heart__when" }, h("time", { datetime: latest.at }, stamp(latest.at)), latest.source === "simulated" ? h("span", { class: "pill" }, "Simulated") : null),
      heartChart({
        title: latest.text,
        samples: latest.samples,
        everySec: latest.everySec,
        restingBpm: latest.restingBpm,
        peak: latest.kind === "lifted" ? { bpm: latest.peakBpm, atSec: latest.peakAtSec } : null,
      }),
      h("p", null, latest.text),
    ),
  );
  if (earlier.length) {
    section.append(
      more(`Earlier (${earlier.length})`, () =>
        h(
          "ol",
          { class: "responses" },
          earlier.map((session) => h("li", { class: "event" }, h("time", { datetime: session.at }, stamp(session.at)), h("p", null, session.source === "simulated" ? `${session.text} (Simulated)` : session.text))),
        ),
      ),
    );
  }
  section.append(h("p", { class: "muted small" }, "Noted only while the memory is open. Moving or talking changes heart rate too, so this shows what happened, not how they felt."));
  return section;
}

export function memoryView({ id, params, onCleanup }) {
  const host = h("div", { class: "stack" });
  const notice = statusLine();
  let prefill = params.get("q") ?? "";
  // Just added with photos or a video: its glasses copy is made straight away, once.
  let justAdded = params.has("new");
  // The film stops when the page is drawn again, or left.
  let stopLane = null;
  onCleanup(() => stopLane?.());

  const load = () => {
    stopLane?.();
    stopLane = null;
    return loadInto(
      host,
      // A memory that has gone has no heart rate either; the page says so below.
      () => Promise.all([api.stats(90), api.questions(), api.memoryActivity(id), api.memoryHeart(id).catch(() => null), loadMembers()]),
      ([stats, questions, activity, heart]) => {
        // Heart rate has its own part of the page, so it is not repeated in the list.
        const responses = activity.filter((item) => item.type !== "heart_response");
        const memory = stats.keepsakes.find((k) => k.id === id);
        if (!memory) {
          host.append(h("h1", { tabindex: "-1" }, "Memory not found"), h("a", { class: "btn btn--primary", href: "#/memories" }, "Back to Memories"));
          return;
        }
        const Wearer = stats.wearerName || "They";
        document.title = `${memory.name} · Memory Lane`;
        const reload = async (message) => {
          await refreshOpenQuestions();
          await load();
          notice.ok(message);
        };

        // ---- What is seen and heard ------------------------------------------------------
        // With photos or a video, the memory lane; otherwise the thing it belongs to.
        if (!memory.lane && memory.referencePhotos.length) {
          host.append(h("div", { class: "hero" }, h("img", { src: memory.referencePhotos[0], alt: "" })));
        }

        const by = memory.from || memory.addedByName;
        const usage = memory.plays ? `opened ${times(memory.plays)}, last ${formatDate(memory.lastPlayedAt, { day: "numeric", month: "short" })}` : "not opened yet";
        host.append(
          h("div", null, h("h1", { tabindex: "-1" }, memory.name), h("p", { class: "lede" }, [by ? `From ${by}` : null, usage].filter(Boolean).join(" · "))),
          notice.el,
        );
        if (memory.lane) {
          host.append(lanePanel(memory, { onCleanup: (stop) => (stopLane = stop), makeLens: justAdded }));
          justAdded = false;
        } else if (memory.voiceNote) {
          host.append(h("audio", { controls: true, preload: "none", src: memory.voiceNote, class: "audio-player", "aria-label": "Voice message" }));
        }
        if (memory.story) host.append(h("p", { class: "quote" }, memory.story));

        // ---- How the wearer has responded to it -------------------------------------------
        host.append(
          h(
            "section",
            { class: "section" },
            h("h2", null, stats.wearerName ? `How ${stats.wearerName} responded` : "How they responded"),
            !stats.careSignals
              ? h("p", { class: "muted" }, "This isn't being noted. You can switch it on under Privacy and agreement.")
              : responses.length
                ? h(
                    "ol",
                    { class: "responses" },
                    responses.map((item) =>
                      h("li", { class: "event" }, h("time", { datetime: item.at }, `${formatDate(item.at, { day: "numeric", month: "short" })}, ${formatTime(item.at)}`), h("p", null, item.text)),
                    ),
                  )
                : h("p", { class: "muted" }, "Nothing yet. Each time it's opened, watched again or asked about, it shows here."),
          ),
        );

        // ---- Their heart rate while it was open -------------------------------------------
        host.append(heartSection(heart, stats.wearerName));

        // ---- Questions about it ----------------------------------------------------------
        const waiting = stillWaiting({ open: questions.open.filter((q) => q.keepsakeId === memory.id), answered: [] }, [memory]);
        const list = h("ul", { class: "list" });
        let closeOpen = null;
        let openFromLink = null;
        for (const item of waiting) {
          const formHost = h("div", { class: "item__open appear", hidden: true });
          const button = h("button", { type: "button", class: "btn btn--primary", "aria-expanded": "false" }, "Answer");
          const close = () => {
            clear(formHost);
            formHost.hidden = true;
            button.setAttribute("aria-expanded", "false");
            button.hidden = false;
            closeOpen = null;
          };
          const open = () => {
            closeOpen?.();
            formHost.append(
              answerForm({
                question: item.question,
                memory,
                onCleanup,
                onCancel: close,
                onAsked: (message) => notice.ok(message),
                onSaved: () => reload(`Saved. ${Wearer} will hear your answer.`),
              }).el,
            );
            formHost.hidden = false;
            button.setAttribute("aria-expanded", "true");
            button.hidden = true;
            closeOpen = close;
          };
          button.addEventListener("click", open);
          list.append(
            h(
              "li",
              null,
              h(
                "div",
                { class: "item" },
                h("div", { class: "item__main" }, h("p", { class: "item__title" }, `“${item.question}”`), h("p", { class: "item__meta" }, `Asked ${times(item.count)} · waiting`)),
                button,
              ),
              formHost,
            ),
          );
          if (prefill && prefill === item.question) {
            prefill = "";
            openFromLink = open;
          }
        }
        for (const answer of memory.answers) {
          const who = state.members.find((m) => m.id === answer.addedBy)?.name || answer.speaker;
          list.append(
            h(
              "li",
              null,
              fold(
                h("div", { class: "item__main" }, h("p", { class: "item__title item__title--plain" }, `“${answer.question}”`), who ? h("p", { class: "item__meta" }, who) : null),
                () =>
                  answerBody(answer, {
                    onDelete: async () => {
                      const agreed = await confirmDialog({ title: "Delete this answer?", body: "The glasses won't have an answer for it.", confirmLabel: "Delete" });
                      if (!agreed) return;
                      try {
                        await api.deleteAnswer(memory.id, answer.id);
                        reload("Answer deleted.");
                      } catch (error) {
                        notice.error(error.message);
                      }
                    },
                  }),
              ),
            ),
          );
        }
        const moreQuestions = showFirst(list);
        if (openFromLink) {
          moreQuestions.reveal();
          queueMicrotask(openFromLink);
        }
        host.append(
          h(
            "section",
            { class: "section" },
            h("h2", null, "Questions"),
            list.children.length ? [list, moreQuestions.el] : null,
            more("Add an answer", () => answerForm({ memory, onCleanup, onSaved: () => reload(`Saved. ${Wearer} will hear your answer.`) }).el),
          ),
        );

        // ---- How the glasses know it -------------------------------------------------------
        // More photos of the object, and a prompt for a close-up when its self-test found the
        // glasses could take a look-alike for it.
        const roomFor = Math.min(4, 8 - memory.referencePhotos.length);
        const addPhotos = () => {
          const status = statusLine();
          const picker = photoPicker({
            legend: "Close-up photos",
            hint: "Something only this one has: a mark, a label, wear, the underside.",
            max: roomFor,
            altPrefix: "Close-up",
          });
          onCleanup(() => picker.destroy());
          const save = h("button", { type: "submit", class: "btn btn--primary" }, "Add");
          return h(
            "form",
            {
              class: "form",
              novalidate: true,
              onsubmit: async (event) => {
                event.preventDefault();
                await picker.whenReady();
                if (!picker.getFiles().length) {
                  status.error("Choose a photo first.");
                  return picker.input.focus();
                }
                save.disabled = true;
                try {
                  await api.addKeepsakePhotos(memory.id, picker.getFiles(), (share) => status.set(`Sending… ${Math.round(share * 100)}%`));
                  reload("Added. The glasses will take a minute or two to learn it again.");
                } catch (error) {
                  save.disabled = false;
                  status.error(error.message);
                }
              },
            },
            picker.el,
            status.el,
            h("div", { class: "row" }, save),
          );
        };
        host.append(
          h(
            "section",
            { class: "section" },
            h("h2", null, "How the glasses know it"),
            memory.mightBeMistaken
              ? h(
                  "div",
                  { class: "card card--warn" },
                  h("p", null, "In a test, the glasses took a similar object for this one. A close-up of something only yours has helps them tell it apart."),
                )
              : null,
            h(
              "ul",
              { class: "thumbs" },
              memory.referencePhotos.map((src, index) => h("li", { class: "thumb" }, h("img", { src, alt: `Photo of the object ${index + 1}`, class: "thumb__img" }))),
            ),
            roomFor > 0 ? more("Add a close-up photo", addPhotos, { open: memory.mightBeMistaken }) : null,
          ),
        );

        // ---- Edit --------------------------------------------------------------------------
        host.append(
          h(
            "div",
            { class: "section" },
            more(
              "Edit memory",
              () => {
                const status = statusLine();
                const name = h("input", { type: "text", maxLength: 80, value: memory.name });
                const from = h("input", { type: "text", maxLength: 60, value: memory.from ?? "" });
                const story = h("textarea", { rows: 3, maxLength: 1200 });
                story.value = memory.story ?? "";
                // The recording, written down for them to check. It is only saved with the form.
                const written = statusLine();
                const writeDown = h("button", { type: "button", class: "link" }, "Write down what the recording says");
                writeDown.addEventListener("click", async () => {
                  writeDown.disabled = true;
                  written.set("Listening to the recording…");
                  try {
                    const { text } = await api.transcribeVoice(memory.id);
                    story.value = text;
                    written.ok("Written down from the recording. Read it through, correct anything misheard, then save.");
                    story.focus();
                  } catch (error) {
                    written.error(error.message);
                  }
                  writeDown.disabled = false;
                });
                const intro = h("input", { type: "text", maxLength: 200, value: memory.introLine ?? "" });
                const description = h("textarea", { rows: 2, maxLength: 400 });
                description.value = memory.description ?? "";
                const inIt = new Set(memory.people ?? []);
                const save = h("button", { type: "submit", class: "btn btn--primary" }, "Save");
                return h(
                  "form",
                  {
                    class: "form",
                    novalidate: true,
                    onsubmit: async (event) => {
                      event.preventDefault();
                      if (!name.value.trim()) {
                        name.setAttribute("aria-invalid", "true");
                        status.error("Give it a name.");
                        return name.focus();
                      }
                      save.disabled = true;
                      try {
                        await api.updateKeepsake(memory.id, { name: name.value.trim(), from: from.value.trim(), story: story.value.trim(), introLine: intro.value.trim(), description: description.value.trim(), people: [...inIt] });
                        reload("Saved.");
                      } catch (error) {
                        save.disabled = false;
                        status.error(error.message);
                      }
                    },
                  },
                  field({ label: "Name", control: name }),
                  field({ label: "The story", control: story, optional: true }),
                  memory.voiceNote ? h("div", { class: "row" }, writeDown) : null,
                  memory.voiceNote ? written.el : null,
                  field({ label: "From", control: from, optional: true }),
                  state.members.length
                    ? h(
                        "fieldset",
                        { class: "fieldset" },
                        h("legend", null, "Who's in it?"),
                        state.members.map((member) =>
                          h(
                            "label",
                            { class: "check" },
                            h("input", { type: "checkbox", checked: inIt.has(member.id), onchange: (event) => (event.target.checked ? inIt.add(member.id) : inIt.delete(member.id)) }),
                            h("span", null, member.name),
                          ),
                        ),
                      )
                    : null,
                  field({ label: "Describe the object", control: description, optional: true }),
                  field({ label: "First words", control: intro, optional: true }),
                  h("p", { class: "field__hint" }, "To change its recordings, add it again. Photos of the object can be added above."),
                  status.el,
                  h(
                    "div",
                    { class: "row" },
                    save,
                    h(
                      "button",
                      {
                        type: "button",
                        class: "link link--danger",
                        onclick: async () => {
                          const agreed = await confirmDialog({ title: `Delete “${memory.name}”?`, body: "Its photos, recordings and answers go for good.", confirmLabel: "Delete" });
                          if (!agreed) return;
                          try {
                            await api.deleteKeepsake(memory.id);
                            window.location.hash = "#/memories";
                          } catch (error) {
                            status.error(error.message);
                          }
                        },
                      },
                      "Delete memory",
                    ),
                  ),
                );
              },
              { quiet: true },
            ),
          ),
        );
      },
    );
  };
  load();

  return h("div", { class: "page" }, host);
}
