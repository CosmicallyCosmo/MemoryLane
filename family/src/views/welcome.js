// The first visit: one question at a time instead of one long form. The first person to arrive
// sets the household up (who they are, who wears the glasses, the wearer's agreement, what to
// note); anyone who joins later only says who they are, then sees what they can do.
import { api } from "../api.js";
import { clear, h, icon, statusLine, uid } from "../dom.js";
import { loadMembers, refreshHousehold, setMe, state } from "../state.js";
import { relationshipPicker } from "../ui.js";
import { agreementForm } from "./consent.js";

const STEPS = ["you", "wearer", "agree", "choices"];

const brand = () => h("span", { class: "brand" }, h("img", { class: "mark", src: "/memorylane-mark.svg", alt: "", width: 34, height: 34 }), "MemoryLane");

export function welcomeView({ params }) {
  const root = h("div", { class: "welcome" });
  let profile = null;
  const wearerName = () => profile?.wearerName || "the wearer";

  function top(step) {
    const index = STEPS.indexOf(step);
    return h(
      "div",
      { class: "welcome__top" },
      brand(),
      index >= 0
        ? h(
            "div",
            { class: "row", style: "gap:12px" },
            h("span", { class: "muted small welcome__step", "aria-hidden": "true" }, `Step ${index + 1} of ${STEPS.length}`),
            h("div", { class: "progress-steps", role: "img", "aria-label": `Step ${index + 1} of ${STEPS.length}` }, STEPS.map((_, i) => h("span", { class: i <= index ? "done" : "" }))),
          )
        : null,
    );
  }

  function show(step) {
    clear(root).append(top(step), ...BUILD[step]());
    window.scrollTo(0, 0);
    root.querySelector("h1")?.focus({ preventScroll: true });
  }

  const back = (step) => h("button", { type: "button", class: "link link--quiet", onclick: () => show(step) }, "Go back");

  /** A form whose submit runs `save`, with the button disabled while it does. */
  function stepForm({ label, save, children, after }) {
    const status = statusLine();
    const submit = h("button", { type: "submit", class: "btn btn--primary btn--big btn--block" }, label);
    return h(
      "form",
      {
        class: "form",
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          if (submit.disabled) return;
          submit.disabled = true;
          status.clear();
          try {
            await save(status);
          } catch (error) {
            status.error(error.message);
          } finally {
            submit.disabled = false;
          }
        },
      },
      children,
      status.el,
      submit,
      after ? h("div", { class: "row", style: "justify-content:center" }, after) : null,
    );
  }

  const BUILD = {
    hello: () => [
      h("h1", { tabindex: "-1" }, "Welcome"),
      h("p", { class: "lede" }, "Memories in everyday things, in your family's voices."),
      h(
        "ul",
        { class: "points" },
        [
          ["memories", "Memories in objects", "They look, and hear your voice."],
          ["question", "Answer once", "Your answer plays every time they ask."],
          ["shield", "Their choice", "Nothing works until they agree."],
        ].map(([name, title, body]) => h("li", null, h("span", { class: "badge-icon", "aria-hidden": "true" }, icon(name, 26)), h("div", null, h("strong", null, title), h("span", { class: "muted" }, body)))),
      ),
      h("div", { style: "margin-top:40px" }, h("button", { type: "button", class: "btn btn--primary btn--big btn--block", onclick: () => show("you") }, "Get started")),
    ],

    you: () => {
      const name = h("input", { type: "text", class: "big-input", maxLength: 60, autocomplete: "given-name", id: uid("name"), value: state.me?.name ?? "" });
      const relation = relationshipPicker({ initial: state.me?.relationship ?? "", legend: "How are you related?" });
      return [
        h("h1", { tabindex: "-1" }, "About you"),
        stepForm({
          label: "Continue",
          after: back("hello"),
          children: [h("div", { class: "field" }, h("label", { class: "field__label", for: name.id }, "Your name"), name), relation.el],
          save: async (status) => {
            const typed = name.value.trim();
            if (!typed) {
              name.setAttribute("aria-invalid", "true");
              name.focus();
              return status.error("Type your name.");
            }
            name.removeAttribute("aria-invalid");
            const details = { name: typed, relationship: relation.value() };
            // Coming back to this step changes the person already added, not a second one.
            const member = state.me ? await api.updateMember(state.me.id, details) : await api.addMember(details);
            await loadMembers();
            setMe(state.members.find((m) => m.id === member.id) ?? member);
            profile = await api.profile();
            show("wearer");
          },
        }),
      ];
    },

    wearer: () => {
      const wearer = h("input", { type: "text", class: "big-input", maxLength: 60, autocomplete: "off", id: uid("wearer"), value: profile?.wearerName ?? "" });
      const carer = h("input", { type: "text", maxLength: 60, autocomplete: "off", id: uid("carer"), value: profile?.carerName || state.me?.name || "" });
      return [
        h("h1", { tabindex: "-1" }, "Who will wear the glasses?"),

        stepForm({
          label: "Continue",
          after: back("you"),
          children: [
            h("div", { class: "field" }, h("label", { class: "field__label", for: wearer.id }, "What do you call them?"), wearer),
            h(
              "div",
              { class: "field" },
              h("label", { class: "field__label", for: carer.id }, "Main carer", h("span", { class: "field__optional" }, " (optional)")),
              carer,
            ),
          ],
          save: async (status) => {
            if (!wearer.value.trim()) {
              wearer.setAttribute("aria-invalid", "true");
              wearer.focus();
              return status.error("Type a name.");
            }
            wearer.removeAttribute("aria-invalid");
            profile = await api.saveProfile({ wearerName: wearer.value.trim(), carerName: carer.value.trim() }, state.me?.id);
            await refreshHousehold();
            show("agree");
          },
        }),
      ];
    },

    agree: () => {
      const name = wearerName();
      if (profile?.consent?.wearerAgreed) {
        return [
          h("h1", { tabindex: "-1" }, `${name} has agreed`),
          h("button", { type: "button", class: "btn btn--primary btn--big btn--block", onclick: () => show("choices") }, "Continue"),
          h("div", { class: "row", style: "justify-content:center" }, back("wearer")),
        ];
      }
      return [
        h("h1", { tabindex: "-1" }, `Does ${name} agree?`),
        agreementForm({
          wearer: name,
          onSaved: async () => {
            profile = await api.profile();
            show("choices");
          },
          extra: h("button", { type: "button", class: "link link--quiet", onclick: () => show("choices") }, "Later"),
        }),
        h("p", null, back("wearer")),
      ];
    },

    choices: () => {
      const option = (key, title, body) => {
        const input = h("input", { type: "checkbox", checked: Boolean(profile?.consent?.[key]), dataset: { key } });
        return h("label", { class: "option" }, input, h("span", null, h("span", { class: "option__title" }, title), body ? h("span", { class: "muted small" }, body) : null));
      };
      const options = h(
        "div",
        { class: "options" },
        option("careSignals", "Track questions", "Recommended. So you can answer them."),
        option("logUnknownObjects", "Note new things", "A few words, never the picture."),
        option("heartRate", "Note heart rate", "Only while a memory is open."),
      );
      return [
        h("h1", { tabindex: "-1" }, "Choose what to track"),
        stepForm({
          label: "Continue",
          after: back("agree"),
          children: options,
          save: async () => {
            const consent = Object.fromEntries([...options.querySelectorAll("input")].map((input) => [input.dataset.key, input.checked]));
            profile = await api.saveProfile({ consent }, state.me?.id);
            show("done");
          },
        }),
      ];
    },

    done: () => {
      const joined = !profile;
      const name = state.wearerName || "the wearer";
      const agreed = joined || profile.consent?.wearerAgreed;
      const step = (href, iconName, title) =>
        h("a", { class: "next-step", href }, h("span", { class: "badge-icon", "aria-hidden": "true" }, icon(iconName, 24)), h("span", null, title), icon("right", 22));
      const me = `#/family/${encodeURIComponent(state.me?.id ?? "")}`;
      return [
        h("h1", { tabindex: "-1" }, joined ? `Welcome, ${state.me?.name?.split(/\s+/)[0] ?? ""}` : agreed ? "All set" : "Nearly there"),
        h(
          "div",
          { class: "next-steps" },
          agreed ? null : step("#/consent", "shield", `Record ${name}'s agreement`),
          step("#/memories?add=1", "photo", "Add a memory"),
          step(me, "mic", "Record your hello"),
          joined ? step("#/home", "question", "Answer a question") : step("#/family", "family", "Invite family"),
          joined ? null : step("#/settings", "glasses", "Connect the glasses"),
        ),
        h("div", { style: "margin-top:32px" }, h("a", { class: "btn btn--big btn--block", href: "#/home" }, "Go to Home")),
      ];
    },
  };

  if (params.get("joined") === "1") show("done");
  else if (!state.me) show("hello");
  else {
    // Coming back to finish: start after "who are you", with what was already saved.
    root.append(top("wearer"), h("p", { class: "loading" }, "Loading…"));
    api
      .profile()
      .then((saved) => (profile = saved))
      .catch(() => (profile = {}))
      .finally(() => show("wearer"));
  }
  return root;
}
