// Home: the first page. The family along the top, how the wearer has been, then what they have
// been wondering that nobody has answered, then the memories they keep going back to, things
// that could hold a memory, and the answers already there.
import { api } from "../api.js";
import { avatar, clear, confirmDialog, formatDate, formatTime, h, icon, loadInto, statusLine } from "../dom.js";
import { sameQuestion, stillWaiting } from "../match.js";
import { getRange, refreshOpenQuestions, setRange, state } from "../state.js";
import { answerBody, answerForm, fold, more, showFirst } from "../ui.js";
import { memoryTile } from "./memories.js";

const RANGES = [
  [7, "Week"],
  [30, "Month"],
];

/** "today at 14:10", "yesterday at 09:05", "on 3 March". */
export function when(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `today at ${formatTime(iso)}`;
  if (days === 1) return `yesterday at ${formatTime(iso)}`;
  return `on ${formatDate(iso, { day: "numeric", month: "long" })}`;
}
export const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

export function homeView({ params, onCleanup }) {
  const host = h("div", { class: "stack" });
  const notice = statusLine();
  let days = RANGES.some(([d]) => d === getRange()) ? getRange() : 7;
  let prefill = params.get("q") ?? "";

  const load = () =>
    loadInto(
      host,
      () => Promise.all([api.questions(), api.keepsakes(), api.stats(days)]),
      ([questions, memories, stats]) => {
        const wearer = stats.wearerName || "they";
        const Wearer = stats.wearerName || "They";
        const waiting = stillWaiting(questions, memories);
        const memoryOf = (id) => memories.find((m) => m.id === id) ?? null;
        const reload = async (message) => {
          await refreshOpenQuestions();
          await load();
          notice.ok(message);
        };

        // ---- The family, as a row of faces ------------------------------------------------
        host.append(
          h(
            "ul",
            { class: "people-row", "aria-label": "Family" },
            state.members.map((member) =>
              h("li", null, h("a", { class: "person", href: `#/family/${encodeURIComponent(member.id)}` }, avatar(member), h("span", null, member.id === state.me?.id ? "You" : member.name.split(/\s+/)[0]))),
            ),
            h("li", null, h("a", { class: "person person--add", href: "#/family" }, h("span", { class: "avatar", "aria-hidden": "true" }, icon("plus", 30)), h("span", null, "Invite"))),
          ),
        );

        // ---- Setting up, until everything that makes the glasses helpful is done ------------
        const me = state.members.find((m) => m.id === state.me?.id) ?? state.me;
        const todo = [
          [Boolean(stats.wearerName), "Name the wearer", "#/welcome"],
          [state.wearerAgreed, "Record their agreement", "#/consent"],
          [stats.careSignals, "Turn on questions", "#/consent"],
          [memories.length > 0, "Add a memory", "#/memories?add=1"],
          [Boolean(me?.introText || me?.introAudio), "Record your hello", `#/family/${encodeURIComponent(state.me?.id ?? "")}`],
        ];
        const left = todo.filter(([done]) => !done).length;
        if (left) {
          host.append(
            h(
              "section",
              { class: "card", "aria-labelledby": "getting-started" },
              h("div", { class: "section__head" }, h("h2", { class: "card__title", id: "getting-started" }, "Finish setting up"), h("span", { class: "pill pill--warn" }, `${left} left`)),
              h(
                "ul",
                { class: "ticks" },
                todo.map(([done, label, href]) =>
                  h(
                    "li",
                    null,
                    h("span", { class: `tick ${done ? "tick--yes" : ""}`, "aria-hidden": "true" }, done ? icon("check", 18) : null),
                    done ? h("span", { class: "muted" }, h("span", { class: "visually-hidden" }, "Done: "), label) : h("a", { href }, label),
                  ),
                ),
              ),
            ),
          );
        }

        // ---- How they have been: two numbers ---------------------------------------------
        const t = stats.totals;
        const stat = (value, label) => h("div", { class: "stat" }, h("strong", null, String(value)), h("span", null, label));
        host.append(
          h(
            "section",
            { class: "section", "aria-labelledby": "how-they-are" },
            h(
              "div",
              { class: "section__head" },
              h("h2", { id: "how-they-are" }, stats.wearerName ? `${stats.wearerName}'s ${days === 7 ? "week" : "month"}` : `This ${days === 7 ? "week" : "month"}`),
              h(
                "div",
                { class: "segmented", role: "group", "aria-label": "Show" },
                RANGES.map(([value, label]) =>
                  h(
                    "button",
                    {
                      type: "button",
                      "aria-pressed": String(value === days),
                      onclick: () => {
                        days = value;
                        setRange(value);
                        load();
                      },
                    },
                    label,
                  ),
                ),
              ),
            ),
            h(
              "div",
              { class: "stats" },
              stat(t.memoriesPlayed, t.memoriesPlayed === 1 ? "memory opened" : "memories opened"),
              stats.careSignals
                ? stat(t.questionsAsked, t.questionsAsked ? `asked · ${t.questionsAnswered} answered` : "questions asked")
                : h("a", { class: "stat", href: "#/consent", style: "text-decoration:none" }, h("strong", null, "Off"), h("span", null, "Questions not tracked")),
            ),
          ),
        );

        // The same question again and again can mean someone is unsettled. Say so gently.
        const nudge = stats.nudges[0];
        if (nudge) {
          host.append(h("p", { class: "note" }, `${Wearer} asked “${nudge.question}” ${times(nudge.timesInHalfHour)} in half an hour, ${when(nudge.lastAt)}. Maybe give them a call.`));
        }
        host.append(notice.el);

        // ---- What they have been wondering ---------------------------------------------
        const waitingList = h("ul", { class: "cards" });
        let closeOpen = null;
        let openFromLink = null;
        for (const item of waiting) {
          const memory = memoryOf(item.keepsakeId);
          const formHost = h("div", { class: "appear", hidden: true });
          const button = h("button", { type: "button", class: "btn btn--primary btn--block", "aria-expanded": "false" }, icon("mic", 22), "Answer");
          const close = () => {
            clear(formHost);
            formHost.hidden = true;
            button.setAttribute("aria-expanded", "false");
            button.hidden = false;
            if (closeOpen === close) closeOpen = null;
          };
          const open = () => {
            closeOpen?.();
            const form = answerForm({
              question: item.question,
              memory,
              onCleanup,
              onCancel: close,
              onAsked: (message) => notice.ok(message),
              onSaved: () => reload(`Saved. ${Wearer} will hear your answer.`),
            });
            formHost.append(form.el);
            formHost.hidden = false;
            button.setAttribute("aria-expanded", "true");
            button.hidden = true;
            closeOpen = close;
          };
          button.addEventListener("click", open);
          const li = h(
            "li",
            { class: "card" },
            h("p", { class: "qcard__question" }, `“${item.question}”`),
            h("p", { class: "qcard__meta" }, [`Asked ${times(item.count)}`, when(item.lastAt), memory?.name].filter(Boolean).join(" · ")),
            button,
            formHost,
          );
          waitingList.append(li);
          if (prefill && sameQuestion(prefill, item.question)) {
            prefill = "";
            openFromLink = () => {
              open();
              li.scrollIntoView({ block: "center" });
            };
          }
        }
        const moreWaiting = showFirst(waitingList);
        if (openFromLink) {
          moreWaiting.reveal();
          queueMicrotask(openFromLink);
        }
        host.append(
          h(
            "section",
            { class: "section" },
            h("div", { class: "section__head" }, h("h2", null, "Questions"), waiting.length ? h("span", { class: "pill pill--warn" }, `${waiting.length} waiting`) : null),
            waiting.length ? [waitingList, moreWaiting.el] : h("p", { class: "muted" }, stats.careSignals ? "All answered." : "Question tracking is off."),
          ),
        );

        // ---- The memories they keep going back to ---------------------------------------
        const favourites = stats.keepsakes.filter((k) => k.plays > 0).slice(0, 6);
        if (favourites.length) {
          host.append(
            h(
              "section",
              { class: "section" },
              h("div", { class: "section__head" }, h("h2", null, "Favourites"), h("a", { class: "link link--quiet", href: "#/memories" }, "See all")),
              h("ul", { class: "strip" }, favourites.map((k) => memoryTile(k, `Opened ${times(k.plays)}`))),
            ),
          );
        }

        // ---- The memories their heart rate rose during -----------------------------------
        // Only those where it rose at least twice, most often first.
        const rose = stats.keepsakes
          .filter((k) => k.heart?.lifted >= 2)
          .sort((a, b) => b.heart.lifted / b.heart.sessions - a.heart.lifted / a.heart.sessions || b.heart.averageRise - a.heart.averageRise)
          .slice(0, 3);
        if (rose.length) {
          host.append(
            h(
              "section",
              { class: "section" },
              h("h2", null, `${stats.wearerName ? `${stats.wearerName}'s` : "Their"} heart rate rose while watching`),
              h("ul", { class: "strip" }, rose.map((k) => memoryTile(k, `${k.heart.lifted} of ${k.heart.sessions} times${k.heart.simulated ? " (simulated)" : ""}`))),
              h("p", { class: "muted small" }, "Moving or talking changes heart rate too. This says nothing about how they felt."),
            ),
          );
        }

        // ---- Things that could hold a memory --------------------------------------------
        const ideas = stats.unknownObjects.slice(0, 4);
        if (ideas.length) {
          host.append(
            h(
              "section",
              { class: "section" },
              h("h2", null, `${Wearer} keeps looking at`),
              h(
                "ul",
                { class: "list" },
                ideas.map((idea) =>
                  h(
                    "li",
                    null,
                    h(
                      "a",
                      { class: "item", href: "#/memories?add=1" },
                      h("span", { class: "badge-icon", "aria-hidden": "true" }, icon("search", 24)),
                      h("span", { class: "item__main" }, h("span", { class: "item__title item__title--plain", style: "display:block" }, idea.label.replace(/^./, (c) => c.toUpperCase())), h("span", { class: "item__meta" }, `${times(idea.count)} · Add a memory`)),
                      icon("plus", 24),
                    ),
                  ),
                ),
              ),
            ),
          );
        }

        // ---- Answers already there ------------------------------------------------------
        const answered = h("ul", { class: "list" });
        for (const answer of questions.answered) {
          const by = answer.addedByName || answer.speaker;
          answered.append(
            h(
              "li",
              null,
              fold(
                h(
                  "div",
                  { class: "item__main" },
                  h("p", { class: "item__title item__title--plain" }, `“${answer.question}”`),
                  h("p", { class: "item__meta" }, [by, answer.timesUsed ? `heard ${times(answer.timesUsed)}` : null].filter(Boolean).join(" · ")),
                ),
                () =>
                  answerBody(answer, {
                    onDelete: async () => {
                      const agreed = await confirmDialog({
                        title: "Delete this answer?",
                        body: `If ${wearer} asks again, it goes back to Questions.`,
                        confirmLabel: "Delete",
                      });
                      if (!agreed) return;
                      try {
                        await api.deleteQuestionAnswer(answer.id);
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
        const add = more("Add an answer", () =>
          answerForm({
            onCleanup,
            onSaved: () => reload(`Saved. ${Wearer} will hear your answer.`),
          }).el,
        );
        host.append(
          h(
            "section",
            { class: "section" },
            h("h2", null, "Answers"),
            questions.answered.length ? [answered, showFirst(answered).el] : null,
            add,
          ),
        );
        if (prefill) {
          // From a notification about a question that is no longer waiting.
          add.open = true;
          queueMicrotask(() => {
            const input = add.querySelector("input[type=text]");
            if (input) input.value = prefill;
            prefill = "";
          });
        }

        host.append(
          h(
            "ul",
            { class: "group section" },
            h("li", null, h("a", { class: "row-link", href: "#/activity" }, icon("activity", 24), stats.wearerName ? `${stats.wearerName}'s days` : "Day by day", icon("right", 22))),
          ),
        );
      },
    );
  load();

  // The family's faces open the page, as the bar names the app; the heading is for screen readers.
  return h("div", { class: "page" }, h("h1", { class: "visually-hidden", tabindex: "-1" }, "Home"), host);
}
