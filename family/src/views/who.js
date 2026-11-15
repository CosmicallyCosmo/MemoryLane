// "Who are you?": choose yourself from the family, or join it. No passwords: the household
// code is what lets someone in; this only decides whose name goes on what they add.
// The very first visit, when nobody is here yet, is the welcome flow instead (welcome.js).
import { api } from "../api.js";
import { avatar, h, icon, statusLine, uid } from "../dom.js";
import { loadMembers, setMe, state } from "../state.js";
import { relationshipPicker } from "../ui.js";

const go = (hash) => {
  if (window.location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else window.location.hash = hash;
};

export function whoView() {
  const status = statusLine();
  const name = h("input", { type: "text", class: "big-input", maxLength: 60, autocomplete: "given-name", id: uid("name") });
  const relation = relationshipPicker({ legend: "How are you related?" });
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--big btn--block" }, "Join");

  const join = h(
    "form",
    {
      class: "form",
      novalidate: true,
      hidden: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        name.removeAttribute("aria-invalid");
        if (!name.value.trim()) {
          name.setAttribute("aria-invalid", "true");
          status.error("Type your name.");
          name.focus();
          return;
        }
        submit.disabled = true;
        try {
          const member = await api.addMember({ name: name.value.trim(), relationship: relation.value() });
          await loadMembers();
          setMe(state.members.find((m) => m.id === member.id) ?? member);
          go("#/welcome?joined=1");
        } catch (error) {
          submit.disabled = false;
          name.setAttribute("aria-invalid", "true");
          status.error(error.message);
          name.focus();
        }
      },
    },
    h("div", { class: "field" }, h("label", { class: "field__label", for: name.id }, "Your name"), name),
    relation.el,
    status.el,
    h("div", { class: "row" }, submit),
  );
  const notListed = h(
    "button",
    {
      type: "button",
      class: "btn btn--big btn--block",
      onclick: () => {
        join.hidden = false;
        notListed.hidden = true;
        name.focus();
      },
    },
    icon("plus", 18),
    "I'm new here",
  );

  return h(
    "div",
    { class: "welcome" },
    h("div", { class: "welcome__top" }, h("span", { class: "brand" }, h("img", { class: "mark", src: "/memorylane-mark.svg", alt: "", width: 34, height: 34 }), "MemoryLane")),
    h("h1", { tabindex: "-1" }, "Who's here?"),
    h(
      "ul",
      { class: "people-pick" },
      state.members.map((member) =>
        h(
          "li",
          null,
          h(
            "button",
            {
              type: "button",
              class: "person-tile",
              style: "width:100%",
              "aria-current": state.me?.id === member.id ? "true" : null,
              onclick: () => {
                setMe(member);
                go("#/home");
              },
            },
            avatar(member, "lg"),
            h("strong", null, member.name),
            h("span", { class: "muted small" }, member.relationship || "Family"),
          ),
        ),
      ),
    ),
    h("div", null, notListed),
    join,
  );
}
