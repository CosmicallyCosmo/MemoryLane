// Notifications: what has happened that this person might want to act on, newest first and
// grouped by day. Questions waiting for an answer stand out from news.
import { api } from "../api.js";
import { clear, emptyState, formatDate, h, icon, relTime, statusLine } from "../dom.js";
import { onChange, refreshNotifications, state } from "../state.js";

/** The icon for a kind of notice, and whether it asks something of the reader. */
const KINDS = {
  unanswered: ["question", "ask"],
  request: ["question", "ask"],
  repeat: ["alert", "ask"],
  answer_added: ["check", "good"],
  keepsake_added: ["memories", "good"],
  memory_played: ["play", "good"],
  // Neither good nor bad: a number changed, and nothing is known about why.
  heart_lifted: ["activity", ""],
  member_joined: ["family", ""],
  low_battery: ["alert", "ask"],
  unknown_object: ["search", ""],
  lookalike: ["camera", "ask"],
};

function dayLabel(iso) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatDate(iso, { weekday: "long", day: "numeric", month: "long" });
}

function actionFor(notice) {
  if ((notice.type === "unanswered" || notice.type === "request") && notice.question) {
    const href = notice.keepsakeId
      ? `#/memories/${encodeURIComponent(notice.keepsakeId)}?q=${encodeURIComponent(notice.question)}`
      : `#/home?q=${encodeURIComponent(notice.question)}`;
    return href;
  }
  if (notice.type === "member_joined") return "#/family";
  if (notice.keepsakeId) return `#/memories/${encodeURIComponent(notice.keepsakeId)}`;
  if (notice.type === "answer_added") return "#/home";
  if (notice.type === "unknown_object") return "#/memories?add=1";
  return null;
}

export function notificationsView({ onCleanup }) {
  const list = h("div");
  const status = statusLine();
  const markAll = h(
    "button",
    {
      type: "button",
      class: "link",
      onclick: async () => {
        try {
          await api.markRead(state.me.id);
          await refreshNotifications();
        } catch (error) {
          status.error(error.message);
        }
      },
    },
    "Mark all read",
  );

  function draw() {
    clear(list);
    markAll.hidden = state.unread === 0;
    list.hidden = state.notifications.length === 0;
    empty.hidden = !list.hidden;
    let group = null;
    let label = "";
    for (const notice of state.notifications) {
      if (dayLabel(notice.at) !== label) {
        label = dayLabel(notice.at);
        group = h("ul", null);
        list.append(h("section", { class: "day" }, h("h2", { class: "day__label" }, label), group));
      }
      const href = actionFor(notice);
      const [iconName, tone] = KINDS[notice.type] ?? ["bell", ""];
      group.append(
        h(
          "li",
          { class: notice.read ? "read" : "unread" },
          h(
            href ? "a" : "div",
            { class: "notice", href },
            h("span", { class: `notice__icon ${tone ? `notice__icon--${tone}` : ""}`.trim(), "aria-hidden": "true" }, icon(iconName, 26)),
            h(
              "span",
              { class: "item__main" },
              h("span", { class: "notice__title", style: "display:block" }, notice.read ? null : h("span", { class: "visually-hidden" }, "Unread: "), notice.title),
              notice.body ? h("span", { class: "muted", style: "display:block" }, notice.body) : null,
              h("time", { class: "notice__meta", style: "display:block", datetime: notice.at }, relTime(notice.at)),
            ),
          ),
        ),
      );
    }
  }
  const empty = emptyState({ title: "All caught up", body: "Nothing new." });

  onCleanup(onChange(draw));
  draw();
  refreshNotifications();

  return h(
    "div",
    { class: "page" },
    h("header", { class: "page-head" }, h("h1", { tabindex: "-1" }, "Notifications"), markAll),
    status.el,
    empty,
    list,
  );
}
