// Consent, in one place: what Memory Lane is allowed to do, who agreed, when, and every change
// since. The wearer's own agreement comes first because nothing works without it.
import { api } from "../api.js";
import { confirmDialog, formatDate, h, icon, loadInto, modal, pageHead, statusLine, uid } from "../dom.js";
import { refreshHousehold, state } from "../state.js";
import { more } from "../ui.js";

const shortDate = (iso) => formatDate(iso, { day: "numeric", month: "short", year: "numeric" });

/** What is read through with the wearer, in their own words, before their agreement is recorded. */
function readThrough() {
  return [
    `The glasses look for things your family added memories to.`,
    `Pictures are checked, then thrown away.`,
    `Everything they say comes from your family.`,
    `Your questions may be kept so someone can answer them.`,
    `You can stop any time: take them off, or ask us.`,
  ];
}

/**
 * Records the wearer's agreement: who is agreeing, and confirmation that what it means has
 * been gone through with them. Used here and in the first-visit setup.
 */
export function agreementForm({ wearer, onSaved, extra = null }) {
  const status = statusLine();
  const group = uid("who");
  const inPerson = h("input", { type: "radio", name: group, value: "self", checked: true });
  const onBehalf = h("input", { type: "radio", name: group, value: "authority" });
  const authorityName = h("input", { type: "text", maxLength: 60, autocomplete: "off", id: uid("authority") });
  const authorityField = h(
    "div",
    { class: "field", hidden: true },
    h("label", { class: "field__label", for: authorityName.id }, "Their name"),
    h("p", { class: "field__hint" }, "E.g. who holds lasting power of attorney."),
    authorityName,
  );
  const sync = () => {
    authorityField.hidden = !onBehalf.checked;
  };
  inPerson.addEventListener("change", sync);
  onBehalf.addEventListener("change", sync);
  const goneThrough = h("input", { type: "checkbox", id: uid("through") });
  const save = h("button", { type: "submit", class: "btn btn--primary btn--big" }, `${wearer} agrees`);

  return h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (save.disabled) return;
        status.clear();
        authorityName.removeAttribute("aria-invalid");
        goneThrough.removeAttribute("aria-invalid");
        const name = authorityName.value.trim();
        if (onBehalf.checked && !name) {
          authorityName.setAttribute("aria-invalid", "true");
          authorityName.focus();
          return status.error("Add their name.");
        }
        if (!goneThrough.checked) {
          goneThrough.setAttribute("aria-invalid", "true");
          goneThrough.focus();
          return status.error("Tick the box first.");
        }
        save.disabled = true;
        status.set("Saving…");
        try {
          const agreedBy = onBehalf.checked ? `${name}, on ${wearer}'s behalf` : wearer;
          await api.saveProfile({ consent: { wearerAgreed: true, agreedBy } }, state.me?.id);
          await refreshHousehold();
          onSaved?.();
        } catch (error) {
          save.disabled = false;
          status.error(error.message);
        }
      },
    },
    h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, `Read this with ${wearer}:`),
      h("ul", { class: "read-through" }, readThrough().map((line) => h("li", null, line))),
    ),
    h(
      "fieldset",
      { class: "fieldset" },
      h("legend", null, "Who agrees?"),
      h(
        "div",
        { class: "options" },
        h("label", { class: "option" }, inPerson, h("span", null, h("span", { class: "option__title" }, wearer))),
        h("label", { class: "option" }, onBehalf, h("span", null, h("span", { class: "option__title" }, "Someone on their behalf"))),
      ),
      authorityField,
    ),
    h("label", { class: "check", for: goneThrough.id }, goneThrough, h("span", null, "We read it together and they're happy.")),
    status.el,
    h("div", { class: "row" }, save, extra),
  );
}

/** Opens the agreement form in a dialog. Resolves true once it is recorded. */
export function recordAgreement(wearer) {
  return modal({
    title: "Agreement",
    wide: true,
    build: (close) =>
      agreementForm({
        wearer,
        onSaved: () => close(true),
        extra: h("button", { type: "button", class: "link link--quiet", onclick: () => close(false) }, "Cancel"),
      }),
  }).then(Boolean);
}

/** One line of the history, in plain words. */
function describeChange(entry, wearer) {
  const by = entry.byName || "Someone";
  const turned = entry.on ? "turned on" : "turned off";
  switch (entry.what) {
    case "wearerAgreed":
      return entry.on
        ? `${by} recorded ${wearer}'s agreement${entry.agreedBy ? `, given by ${entry.agreedBy}` : ""}.`
        : `${by} took back ${wearer}'s agreement, and the glasses were switched off.`;
    case "careSignals":
      return `${by} ${turned} keeping track of ${wearer}'s questions.`;
    case "logUnknownObjects":
      return `${by} ${turned} noticing things that could hold a memory.`;
    case "heartRate":
      return entry.on
        ? `${by} turned on noting ${wearer}'s heart rate while a memory is open.`
        : `${by} turned off noting ${wearer}'s heart rate, and what had been noted was deleted.`;
    default:
      return null;
  }
}

export function consentView() {
  const host = h("div", { class: "stack" });
  const notice = statusLine();

  const load = () =>
    loadInto(host, api.consent, (data) => {
      const wearer = data.wearerName || "the person wearing the glasses";
      const agreed = data.wearer.agreed;
      const changed = async (message) => {
        await refreshHousehold();
        await load();
        if (message) notice.ok(message);
      };

      // ---- The wearer's agreement ----------------------------------------------------------
      const lastRecorded = data.history.find((entry) => entry.what === "wearerAgreed" && entry.on);
      host.append(
        agreed
          ? h(
              "div",
              { class: "card card--accent" },
              h("div", { class: "row", style: "gap:12px;align-items:flex-start;flex-wrap:nowrap" }, h("span", { class: "tick tick--yes" }, icon("check", 16)), h("div", null, h("h2", { class: "card__title" }, "Glasses on"), h("p", null, `Agreed by ${data.wearer.agreedBy || wearer}${data.wearer.agreedAt ? ` · ${shortDate(data.wearer.agreedAt)}` : ""}${lastRecorded?.byName ? ` · recorded by ${lastRecorded.byName}` : ""}`))),
              h(
                "p",
                null,
                h(
                  "button",
                  {
                    type: "button",
                    class: "link link--danger small",
                    onclick: async () => {
                      const sure = await confirmDialog({
                        title: "Switch the glasses off?",
                        body: "They stop straight away. Everything else stays.",
                        confirmLabel: "Switch off",
                        cancelLabel: "Keep them on",
                      });
                      if (!sure) return;
                      try {
                        await api.saveProfile({ consent: { wearerAgreed: false } }, state.me?.id);
                        changed("Glasses switched off.");
                      } catch (error) {
                        notice.error(error.message);
                      }
                    },
                  },
                  `Switch the glasses off`,
                ),
              ),
            )
          : h(
              "div",
              { class: "card card--warn" },
              h("h2", { class: "card__title" }, "Glasses off"),
              h("p", null, `Until ${wearer} agrees.`),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn--primary btn--block",
                  onclick: async () => {
                    if (await recordAgreement(wearer)) changed("Glasses on.");
                  },
                },
                "Record agreement",
              ),
            ),
      );
      host.append(notice.el);

      // ---- What the glasses do -------------------------------------------------------------
      const choice = ({ title, meaning, on, control, extra }) =>
        h(
          "li",
          { class: "choice" },
          control,
          h(
            "div",
            { class: "choice__text" },
            h("div", { class: "choice__head" }, h("span", { class: "choice__title" }, title), h("span", { class: `pill ${on ? "pill--on" : ""}` }, on ? "On" : "Off")),
            meaning ? h("p", { class: "muted small" }, meaning) : null,
            extra ?? null,
          ),
        );

      const switchFor = (key, label) => {
        const input = h("input", { type: "checkbox", role: "switch", class: "switch__input", checked: data.choices[key], "aria-label": label });
        input.addEventListener("change", async () => {
          input.disabled = true;
          try {
            await api.saveProfile({ consent: { [key]: input.checked } }, state.me?.id);
            changed(`${label}: ${input.checked ? "on" : "off"}.`);
          } catch (error) {
            input.checked = !input.checked;
            input.disabled = false;
            notice.error(error.message);
          }
        });
        return input;
      };

      host.append(
        h(
          "section",
          { class: "section" },
          h("h2", null, "The glasses"),
          h(
            "ul",
            { class: "group" },
            choice({
              title: "Offer memories",
              meaning: "On while they've agreed.",
              on: agreed,
              control: h("span", { class: "badge-icon", "aria-hidden": "true" }, icon("glasses", 24)),
            }),
            choice({
              title: "Track questions",
              meaning: "So the family can answer them.",
              on: data.choices.careSignals,
              control: switchFor("careSignals", "Track questions"),
            }),
            choice({
              title: "Note new things",
              meaning: "A few words, never the picture.",
              on: data.choices.logUnknownObjects,
              control: switchFor("logUnknownObjects", "Note new things"),
            }),
            choice({
              title: "Note heart rate",
              meaning: "Only while a memory is open. Switching it off deletes it.",
              on: data.choices.heartRate,
              control: switchFor("heartRate", "Note heart rate"),
            }),
          ),
        ),
      );

      // ---- Never ------------------------------------------------------------------------------
      host.append(
        h(
          "section",
          { class: "section" },
          h("h2", null, "Never"),
          h(
            "ul",
            { class: "never" },
            [
              "Keep camera pictures",
              "Copy anyone's voice",
              "Make up an answer",
              "Recognise faces",
            ].map((line) => h("li", null, icon("x", 18), h("span", null, line))),
          ),
        ),
      );

      // ---- Memories ---------------------------------------------------------------------------
      host.append(
        h(
          "section",
          { class: "section" },
          h("h2", null, "Consent for memories"),
          data.memories.length
            ? h(
                "ul",
                { class: "list" },
                data.memories.map((memory) =>
                  h(
                    "li",
                    null,
                    h(
                      "a",
                      { class: "item", style: "min-height:56px", href: `#/memories/${encodeURIComponent(memory.id)}` },
                      h("div", { class: "item__main" }, h("p", { class: "item__title item__title--plain" }, memory.name), h("p", { class: "item__meta" }, [memory.confirmedBy, shortDate(memory.confirmedAt)].filter(Boolean).join(" · "))),
                      icon("right", 22),
                    ),
                  ),
                ),
              )
            : h("p", { class: "muted" }, "No memories yet."),
        ),
      );

      // ---- History ----------------------------------------------------------------------------
      const lines = data.history.map((entry) => ({ entry, text: describeChange(entry, wearer) })).filter((line) => line.text);
      const row = ({ entry, text }) => h("li", null, h("time", { datetime: entry.at }, shortDate(entry.at)), h("span", null, text));
      host.append(
        h(
          "section",
          { class: "section" },
          h("h2", null, "History"),
          lines.length
            ? [h("ul", { class: "history" }, lines.slice(0, 8).map(row)), lines.length > 8 ? more(`Show ${lines.length - 8} earlier`, () => h("ul", { class: "history" }, lines.slice(8).map(row)), { quiet: true }) : null]
            : h("p", { class: "muted" }, "Nothing yet."),
        ),
      );
    });
  load();

  return h(
    "div",
    { class: "page" },
    pageHead({ title: "Privacy" }),
    host,
  );
}
