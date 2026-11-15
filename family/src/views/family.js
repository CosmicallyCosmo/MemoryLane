// Family: a plain list of the people who share memories. Each opens their profile.
import { api } from "../api.js";
import { avatar, clear, field, h, icon, loadInto, modal, statusLine } from "../dom.js";
import { loadMembers, state } from "../state.js";
import { more } from "../ui.js";

export function memberForm({ member, onDone }) {
  const name = h("input", { type: "text", maxLength: 60, autocomplete: "off", required: true, value: member?.name ?? "" });
  const relationship = h("input", { type: "text", maxLength: 60, autocomplete: "off", value: member?.relationship ?? "" });
  const status = statusLine();
  const submit = h("button", { type: "submit", class: "btn btn--primary" }, member ? "Save" : "Add");
  queueMicrotask(() => name.focus());
  return h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        name.removeAttribute("aria-invalid");
        if (!name.value.trim()) {
          name.setAttribute("aria-invalid", "true");
          status.error("Add their name.");
          name.focus();
          return;
        }
        submit.disabled = true;
        try {
          const body = { name: name.value.trim(), relationship: relationship.value.trim() };
          onDone(member ? await api.updateMember(member.id, body) : await api.addMember(body));
        } catch (error) {
          submit.disabled = false;
          name.setAttribute("aria-invalid", "true");
          status.error(error.message);
          name.focus();
        }
      },
    },
    field({ label: "Name", control: name }),
    field({ label: "Relationship", control: relationship, optional: true }),
    status.el,
    h("div", { class: "dialog__actions" }, h("button", { type: "button", class: "btn", onclick: () => onDone(null) }, "Cancel"), submit),
  );
}

export function familyView() {
  const host = h("div", { class: "stack" });
  const notice = statusLine();
  const list = h("ul", { class: "list" });

  const draw = () => {
    clear(list);
    for (const member of state.members) {
      list.append(
        h(
          "li",
          null,
          h(
            "a",
            { class: "item", href: `#/family/${encodeURIComponent(member.id)}` },
            avatar(member, "lg"),
            h(
              "span",
              { class: "item__main" },
              h("span", { class: "item__title", style: "display:block" }, member.id === state.me?.id ? `${member.name} (you)` : member.name),
              h("span", { class: "item__meta" }, [member.relationship, member.introAudio || member.introText ? null : "no hello yet"].filter(Boolean).join(" · ") || "Family"),
            ),
            icon("right", 22),
          ),
        ),
      );
    }
  };

  const invite = more("Invite from their phone", () => {
    const body = h("div", null, h("p", { class: "loading" }, "Loading…"));
    api
      .pairing()
      .then((pairing) => {
        clear(body).append(
          h("p", { class: "muted" }, "Same Wi-Fi. Open the address, enter the code."),
          h(
            "dl",
            { class: "facts" },
            h("dt", null, "Web address"),
            h("dd", { class: "mono" }, pairing.urls[0] ?? window.location.origin),
            h("dt", null, "Family code"),
            h("dd", { class: "mono code", "aria-label": pairing.code.split("").join(" ") }, `${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}`),
          ),
        );
      })
      .catch((error) => clear(body).append(h("p", { class: "status status--error" }, error.message)));
    return body;
  });

  loadInto(host, loadMembers, () => {
    host.append(list, invite);
    draw();
  });

  return h(
    "div",
    { class: "page" },
    h(
      "header",
      { class: "page-head" },
      h("h1", { tabindex: "-1" }, "Family"),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn icon-btn--filled",
          "aria-label": "Add someone",
          onclick: async () => {
            const saved = await modal({ title: "Add someone", build: (close) => memberForm({ onDone: close }) });
            if (!saved) return;
            await loadMembers();
            draw();
            notice.ok(`${saved.name} added.`);
          },
        },
        icon("plus", 26),
      ),
    ),
    notice.el,
    host,
  );
}
