// Tiny DOM helpers. Text is always set as text nodes, never as HTML, so nothing a family
// types (or the server returns) can be interpreted as markup.

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "rect", "circle", "line", "g", "text", "title", "polyline"]);

function append(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const item of child) append(parent, item);
    return;
  }
  parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * h("button", { class: "btn", onclick: fn, disabled: true }, "Save")
 * Keys starting with "on" become listeners; `dataset` and `style` take objects; false/null
 * attributes are skipped.
 */
export function h(tag, props, ...children) {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      Object.assign(el.dataset, value);
    } else if (key === "style" && typeof value === "object") {
      for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    } else if (key === "class") {
      el.setAttribute("class", value);
    } else if (!svg && key in el && !key.startsWith("aria") && key !== "list" && key !== "form" && key !== "role") {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true && !key.startsWith("aria") ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

let counter = 0;
export const uid = (prefix = "f") => `${prefix}-${++counter}`;

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatDate(iso, options = { day: "numeric", month: "long", year: "numeric" }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

export const formatTime = (iso) => formatDate(iso, { hour: "2-digit", minute: "2-digit" });

/** "just now", "12 minutes ago", "yesterday", then a plain date. */
export function relTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDate(iso, { day: "numeric", month: "short", year: "numeric" });
}

export function initials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * A person's face if they have added a photo, otherwise their initials. Takes a member or
 * just a name.
 */
export function avatar(who, size = "") {
  const member = typeof who === "string" ? { name: who } : (who ?? {});
  const cls = `avatar ${size ? `avatar--${size}` : ""}`.trim();
  if (member.photo) {
    return h("span", { class: `${cls} avatar--photo`, "aria-hidden": "true" }, h("img", { src: member.photo, alt: "", loading: "lazy" }));
  }
  return h("span", { class: cls, "aria-hidden": "true", style: { "--hue": String(hueOf(member.name)) } }, initials(member.name));
}

/** The same soft colour for the same name, every time. */
function hueOf(name) {
  let hash = 0;
  for (const char of String(name ?? "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
}

/** A labelled field: label, optional hint, and the control wired together. */
export function field({ label, hint, control, optional = false }) {
  const id = control.id || (control.id = uid("field"));
  const parts = [
    h(
      "label",
      { class: "field__label", for: id },
      label,
      optional ? h("span", { class: "field__optional" }, " (optional)") : null,
    ),
  ];
  if (hint) {
    const hintId = `${id}-hint`;
    control.setAttribute("aria-describedby", hintId);
    parts.push(h("p", { class: "field__hint", id: hintId }, hint));
  }
  parts.push(control);
  return h("div", { class: "field" }, parts);
}

/** A polite live region whose message can be swapped: status.set("Saved."), status.error("…"). */
export function statusLine(extraClass = "") {
  const el = h("p", { class: `status ${extraClass}`.trim(), role: "status", "aria-live": "polite" });
  const set = (text, kind) => {
    el.textContent = text ?? "";
    el.classList.toggle("status--error", kind === "error");
    el.classList.toggle("status--ok", kind === "ok");
    el.hidden = !text;
  };
  set("");
  return {
    el,
    set: (text) => set(text),
    ok: (text) => set(text, "ok"),
    error: (text) => set(text, "error"),
    clear: () => set(""),
  };
}

/**
 * A modal dialog. The browser's <dialog> traps focus and closes on Escape. `build(close)`
 * returns the content; the returned promise resolves with whatever `close(value)` is given.
 */
export function modal({ title, build, wide = false }) {
  return new Promise((resolve) => {
    const titleId = uid("dialog");
    const dialog = h("dialog", { class: `dialog ${wide ? "dialog--wide" : ""}`.trim(), "aria-labelledby": titleId });
    const opener = document.activeElement;
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
      resolve(value);
    };
    dialog.append(h("h2", { id: titleId, class: "dialog__title" }, title), build(finish));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    // A click on the dimmed backdrop lands on the dialog element itself.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks before doing something that cannot be undone. Resolves true if the person agrees. */
export function confirmDialog({ title, body, confirmLabel = "Delete", cancelLabel = "Keep it" }) {
  return modal({
    title,
    build: (close) => {
      const cancel = h("button", { type: "button", class: "btn", onclick: () => close(false) }, cancelLabel);
      const ok = h("button", { type: "button", class: "btn btn--danger", onclick: () => close(true) }, confirmLabel);
      queueMicrotask(() => cancel.focus());
      return h("div", null, h("p", { class: "dialog__body" }, body), h("div", { class: "dialog__actions" }, cancel, ok));
    },
  }).then(Boolean);
}

let toastHost = null;
/** A short notice in the corner. Announced politely; goes away on its own. */
export function toast(title, body = "", { href, timeout = 7000 } = {}) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const el = h(
    href ? "a" : "div",
    { class: "toast", href: href ?? null },
    h("p", { class: "toast__title" }, title),
    body ? h("p", { class: "toast__body" }, body) : null,
  );
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add("toast--leaving");
    setTimeout(() => el.remove(), 200);
  }, timeout);
}

// 24px stroke icons, drawn with the text colour.
const ICONS = {
  home: "M4 11.5 12 4l8 7.500M6 10v9.500h12V10M10 19.500v-5h4v5",
  memories: "M12 20s-7-4.300-7-9.500A4 4 0 0 1 12 8a4 4 0 0 1 7 2.500c0 5.200-7 9.500-7 9.500z",
  family: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.500 19c0-3 2.500-5 5.500-5s5.500 2 5.500 5M16.500 11a2.500 2.500 0 1 0 0-5M17 14c2.300.300 3.500 2 3.500 4.500",
  activity: "M3 12h4l2.500-6 4 12 2.500-6h5",
  bell: "M6 16.500V11a6 6 0 1 1 12 0v5.500l1.500 2h-15l1.500-2zM10 20.500a2 2 0 0 0 4 0",
  settings: "M5 7h9M18 7h1M5 12h1M10 12h9M5 17h7M16 17h3M16 5v4M8 10v4M14 15v4",
  mic: "M12 14.500a3 3 0 0 0 3-3V6.500a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6.500 11.500a5.500 5.500 0 0 0 11 0M12 17v3",
  film: "M4.500 6h15v12h-15zM10 9.500v5l4.500-2.500z",
  photo: "M4.500 6h15v12h-15zM4.500 15.500l4-4 3.500 3.500 2.500-2.500 5 4.500M9 9.500h.010",
  chat: "M5 5.500h14v10H10l-5 3.500z",
  plus: "M12 5.500v13M5.500 12h13",
  chevron: "M7 10l5 5 5-5",
  right: "M10 7l5 5-5 5",
  left: "M14 7l-5 5 5 5",
  check: "M5.500 12.500l4.500 4.500 8.500-10",
  search: "M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM15.500 15.500l4 4",
  up: "M12 18V6M7 11l5-5 5 5",
  down: "M12 6v12M7 13l5 5 5-5",
  x: "M6.500 6.500l11 11M17.500 6.500l-11 11",
  glasses: "M3 13.500a3.500 3.500 0 1 0 7 0 3.500 3.500 0 0 0-7 0zM14 13.500a3.500 3.500 0 1 0 7 0 3.500 3.500 0 0 0-7 0zM10 13c.600-.700 3.400-.700 4 0M3 13l1.500-6M21 13l-1.500-6",
  alert: "M12 5l8.500 14.500h-17zM12 10.500v4M12 17.200h.010",
  swap: "M7 8h11l-3-3M17 16H6l3 3",
  question: "M12 20.500a8.500 8.500 0 1 0 0-17 8.500 8.500 0 0 0 0 17zM9.700 9.600a2.400 2.400 0 1 1 3.500 2.100c-.800.500-1.200 1-1.200 1.900M12 16.400h.010",
  speaker: "M4.500 9.500v5h3l4 3.500v-12l-4 3.500zM15 9.500a3.500 3.500 0 0 1 0 5M17.500 7a7 7 0 0 1 0 10",
  camera: "M4 8.500h3l1.500-2.500h7L17 8.500h3v10H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  play: "M8.500 6.500v11l9-5.500z",
  pencil: "M14.500 5.500l4 4L8.500 19.500H4.500v-4zM12.500 7.500l4 4",
  shield: "M12 3.500l7 3v5.500c0 4.200-3 7.300-7 8.500-4-1.200-7-4.300-7-8.500V6.500zM9 12l2 2 4-4",
};

export function icon(name, size = 20) {
  return h(
    "svg",
    { class: "icon", viewBox: "0 0 24 24", width: String(size), height: String(size), "aria-hidden": "true", focusable: "false" },
    h("path", {
      d: ICONS[name] ?? "",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
}

/** Standard page header: title, one line of description, and an action on the right. */
export function pageHead({ title, lede, action, back }) {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      { class: "page-head__text" },
      back ? h("a", { class: "back-link", href: back.href }, icon("left", 16), back.label) : null,
      h("h1", { tabindex: "-1" }, title),
      lede ? h("p", { class: "lede" }, lede) : null,
    ),
    action ? h("div", { class: "page-head__action" }, action) : null,
  );
}

export function emptyState({ title, body, action }) {
  return h("div", { class: "empty" }, h("h2", { class: "empty__title" }, title), h("p", null, body), action ?? null);
}

/** Shown while something loads, and replaced by an error with a retry if it fails. */
export function loadInto(host, loader, render) {
  const run = async () => {
    clear(host).append(h("p", { class: "loading" }, "Loading…"));
    let data;
    try {
      data = await loader();
    } catch (error) {
      clear(host).append(
        h(
          "div",
          { class: "empty", role: "alert" },
          h("h2", { class: "empty__title" }, "Sorry, this didn't load"),
          h("p", null, error.message),
          h("button", { type: "button", class: "btn", onclick: run }, "Try again"),
        ),
      );
      return;
    }
    clear(host);
    render(data);
    // Fade in what loaded. Taking the class off and on again starts the fade over.
    host.classList.remove("loaded");
    void host.offsetWidth;
    host.classList.add("loaded");
  };
  return run();
}
