import { api, CODE_REQUIRED_EVENT } from "./api.js";
import { startAttract } from "./attract.js";
import { avatar, clear, field, h, icon, statusLine } from "./dom.js";
import { loadMembers, onChange, refreshHousehold, startPolling, state } from "./state.js";
import { activityView } from "./views/activity.js";
import { consentView } from "./views/consent.js";
import { familyView } from "./views/family.js";
import { memoriesView } from "./views/memories.js";
import { memoryView } from "./views/memory.js";
import { notificationsView } from "./views/notifications.js";
import { profileView } from "./views/profile.js";
import { homeView } from "./views/home.js";
import { settingsView } from "./views/settings.js";
import { welcomeView } from "./views/welcome.js";
import { whoView } from "./views/who.js";

// The tabs along the bottom, as in any phone app. "Add" is the big button in the middle.
const TABS = [
  { route: "home", label: "Home", icon: "home", href: "#/home" },
  { route: "memories", label: "Memories", icon: "photo", href: "#/memories" },
  { route: "add", label: "Add a memory", short: "Add", icon: "plus", href: "#/memories?add=1" },
  { route: "family", label: "Family", icon: "family", href: "#/family" },
  { route: "notifications", label: "Notifications", short: "Alerts", icon: "bell", href: "#/notifications" },
];

const ROUTES = {
  home: { title: "Home", view: homeView },
  memories: { title: "Memories", view: memoriesView },
  family: { title: "Family", view: familyView },
  activity: { title: "Day by day", view: activityView },
  notifications: { title: "Notifications", view: notificationsView },
  settings: { title: "Settings", view: settingsView },
  consent: { title: "Privacy", view: consentView },
};

/** Which tab a page sits under, and where its back arrow goes (none on a tab's own page). */
function placeOf({ name, id, params }) {
  if (name === "memories" && params.get("add")) return { tab: "add", back: "#/memories" };
  if (name === "memories") return { tab: "memories", back: id ? "#/memories" : null };
  if (name === "family") return { tab: "family", back: id ? "#/family" : null };
  if (name === "home" || name === "notifications") return { tab: name, back: null };
  if (name === "activity") return { tab: "home", back: "#/home" };
  return { tab: null, back: "#/home" };
}

const main = document.getElementById("main");
const topbar = document.getElementById("topbar");
const bottomNav = document.getElementById("bottom-nav");
const banner = document.getElementById("banner");
let cleanups = [];
let firstRender = true;
let openMenu = null;
document.addEventListener("click", (event) => {
  if (openMenu?.open && !openMenu.contains(event.target)) openMenu.open = false;
});

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  let [name = "", id = ""] = path.split("/");
  // Older links: "keepsakes" are memories now, and the Questions page is part of Home.
  if (name === "keepsakes") name = "memories";
  if (name === "questions" || name === "") name = "home";
  return { name, id: decodeURIComponent(id), params: new URLSearchParams(query) };
}

const countBadge = (n, words) =>
  n ? h("span", { class: "badge" }, h("span", { "aria-hidden": "true" }, n > 99 ? "99+" : String(n)), h("span", { class: "visually-hidden" }, `, ${words}`)) : null;

function renderChrome() {
  const where = parseHash();
  const { name } = where;
  // The welcome and "who are you?" pages stand on their own, without the app around them.
  const signedIn = Boolean(state.me) && name !== "welcome" && name !== "who";
  topbar.hidden = !signedIn;
  bottomNav.hidden = !signedIn;
  document.body.classList.toggle("has-tabs", signedIn);
  clear(topbar);
  clear(bottomNav);
  clear(banner);
  // While the wearer has not agreed, the glasses do nothing. Say so on every page but the one
  // where it is put right.
  banner.hidden = !signedIn || state.wearerAgreed || name === "consent";
  if (!banner.hidden) {
    banner.append(
      h(
        "a",
        { class: "banner__inner", href: "#/consent" },
        icon("alert", 22),
        h("span", null, `Glasses off until ${state.wearerName || "the wearer"} agrees`),
        icon("right", 20),
      ),
    );
  }
  if (!signedIn) return;

  const { tab, back } = placeOf(where);
  const menu = h(
    "details",
    { class: "menu" },
    h("summary", { "aria-label": `${state.me.name}: your profile, privacy, settings` }, avatar(state.me)),
    h(
      "div",
      { class: "menu__list" },
      h("p", { class: "menu__who" }, state.me.name),
      h("a", { href: `#/family/${encodeURIComponent(state.me.id)}` }, icon("family", 22), "Your profile"),
      h("a", { href: "#/consent" }, icon("shield", 22), "Privacy"),
      h("a", { href: "#/settings" }, icon("settings", 22), "Settings"),
      h("a", { href: "#/who" }, icon("swap", 22), "Switch person"),
    ),
  );
  // Close the menu when something in it is chosen, or on a click elsewhere.
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) menu.open = false;
  });
  openMenu = menu;

  topbar.append(
    h(
      "div",
      { class: "appbar" },
      // The name sits in the middle of every page; Back, when there is somewhere to go back to, on its left.
      h("div", { class: "appbar__left" }, back ? h("a", { class: "icon-btn", href: back, "aria-label": "Back" }, icon("left", 26)) : null),
      h("a", { class: "wordmark", href: "#/home", "aria-label": "Memory Lane, home" }, h("img", { class: "mark", src: "/memorylane-mark-white.svg", alt: "", width: 34, height: 34 }), "MemoryLane"),
      h("div", { class: "appbar__right" }, menu),
    ),
  );

  // Home carries a count of the questions waiting for an answer, so nobody misses one.
  bottomNav.append(
    h(
      "div",
      { class: "tabbar" },
      TABS.map((item) => {
        const count =
          item.route === "home"
            ? countBadge(state.openQuestions, state.openQuestions === 1 ? "1 question waiting" : `${state.openQuestions} questions waiting`)
            : item.route === "notifications"
              ? countBadge(state.unread, `${state.unread} unread`)
              : null;
        return h(
          "a",
          {
            href: item.href,
            class: item.route === "add" ? "tabbar__add" : null,
            "aria-current": item.route === tab ? "page" : null,
            "aria-label": item.short ? item.label : null,
          },
          h("span", { class: "tabbar__icon" }, icon(item.icon, item.route === "add" ? 30 : 28), count),
          h("span", { class: "tabbar__label", "aria-hidden": item.short ? "true" : null }, item.short ?? item.label),
        );
      }),
    ),
  );
}

function render() {
  const { name, id, params } = parseHash();
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // A view failing to tidy up must not stop the next one from showing.
    }
  }
  clear(main);
  const ctx = { params, id, onCleanup: (fn) => cleanups.push(fn), rerender: render };

  // Nobody is "signed in" as such: the household code lets you in, and then you say who you are
  // so that what you add is credited to you and your notices are yours. The first person to
  // arrive sets the household up.
  if (state.members.length === 0 || (name === "welcome" && state.me)) {
    if (name !== "welcome") history.replaceState(null, "", "#/welcome");
    document.title = "Welcome · Memory Lane";
    renderChrome();
    main.append(welcomeView(ctx));
  } else if (!state.me || name === "who" || name === "welcome") {
    document.title = "Who's here? · Memory Lane";
    renderChrome();
    main.append(whoView(ctx));
  } else {
    renderChrome();
    const route =
      name === "memories" && id
        ? { title: "Memory", view: memoryView }
        : name === "family" && id
          ? { title: "Profile", view: profileView }
          : ROUTES[name];
    if (!route) {
      document.title = "Page not found · Memory Lane";
      main.append(h("div", { class: "page" }, h("h1", { tabindex: "-1" }, "Page not found"), h("a", { class: "btn btn--primary", href: "#/home" }, "Go home")));
    } else {
      document.title = `${route.title} · Memory Lane`;
      main.append(route.view(ctx));
    }
  }

  // Move focus to the new page's heading so keyboard and screen reader users land in the
  // right place. Not on first load, where it would only be a surprise.
  if (!firstRender) {
    window.scrollTo(0, 0);
    main.querySelector("h1")?.focus({ preventScroll: true });
  }
  firstRender = false;
}

// Reached from another computer or phone, the server wants the household code once. Any call
// that is refused for that reason lands here, whichever page made it.
let askingForCode = false;
function askForCode() {
  if (askingForCode) return;
  askingForCode = true;
  document.title = "Family code · Memory Lane";
  topbar.hidden = true;
  bottomNav.hidden = true;
  document.body.classList.remove("has-tabs");
  clear(main);

  const status = statusLine();
  const input = h("input", { type: "text", class: "code-input", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxLength: 12, required: true });
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--block" }, "Continue");
  const heading = h("h1", { tabindex: "-1" }, "Family code");
  main.append(
    h(
      "div",
      { class: "page" },
      heading,
      h("p", { class: "lede" }, "Find it in Settings on the first phone."),
      h(
        "form",
        {
          class: "form",
          novalidate: true,
          onsubmit: async (event) => {
            event.preventDefault();
            if (submit.disabled) return;
            const code = input.value.replace(/\s+/g, "").toUpperCase();
            input.removeAttribute("aria-invalid");
            if (!code) {
              input.setAttribute("aria-invalid", "true");
              status.error("Type the code.");
              input.focus();
              return;
            }
            submit.disabled = true;
            status.set("Checking…");
            try {
              await api.signIn(code);
              window.location.reload();
            } catch (error) {
              submit.disabled = false;
              input.setAttribute("aria-invalid", "true");
              status.error(error.status === 401 ? "That code isn't right." : error.message);
              input.focus();
            }
          },
        },
        field({ label: "Family code", control: input }),
        status.el,
        h("div", { class: "row" }, submit),
      ),
    ),
  );
  heading.focus({ preventScroll: true });
}
window.addEventListener(CODE_REQUIRED_EVENT, askForCode);

window.addEventListener("hashchange", () => {
  if (!askingForCode) render();
});

async function start() {
  main.append(h("div", { class: "page" }, h("p", { class: "loading" }, "Loading…")));
  try {
    await Promise.all([loadMembers(), refreshHousehold()]);
  } catch (error) {
    if (askingForCode) return;
    clear(main).append(
      h(
        "div",
        { class: "page", role: "alert" },
        h("h1", null, "Can't connect"),
        h("p", { class: "lede" }, error.message),
        h("button", { type: "button", class: "btn btn--primary", onclick: () => window.location.reload() }, "Try again"),
      ),
    );
    return;
  }
  onChange(() => {
    if (!askingForCode) renderChrome();
  });
  render();
  startPolling();
  startAttract();
}
start();
