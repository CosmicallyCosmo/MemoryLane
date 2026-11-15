// Everything that happened: the one chart in the app, then a timeline grouped by day.
import { api } from "../api.js";
import { barChart } from "../charts.js";
import { emptyState, formatDate, formatTime, h, loadInto } from "../dom.js";

const PAGE = 60;

function dayLabel(iso) {
  const day = new Date(iso);
  if (!iso || Number.isNaN(day.getTime())) return "Undated";
  if (day.toDateString() === new Date().toDateString()) return "Today";
  if (day.toDateString() === new Date(Date.now() - 86400000).toDateString()) return "Yesterday";
  return formatDate(iso, { weekday: "long", day: "numeric", month: "long" });
}

export function activityView() {
  let limit = PAGE;
  const host = h("div", { class: "stack" });
  const heading = h("h1", { tabindex: "-1" }, "Day by day");

  const load = () =>
    loadInto(
      host,
      () => Promise.all([api.activity(limit), api.stats(30)]),
      ([items, stats]) => {
        if (stats.wearerName) {
          heading.textContent = `${stats.wearerName}'s days`;
          document.title = `${stats.wearerName}'s days · Memory Lane`;
        }
        if (!items.length) {
          host.append(emptyState({ title: "Nothing yet", body: "Their days show here once they wear the glasses." }));
          return;
        }
        host.append(
          barChart({
            title: "Memories opened and questions asked each day, over the last month",
            series: [
              { key: "memories", name: "Memories opened", tone: "ink" },
              { key: "questions", name: "Questions asked", tone: "mid" },
            ],
            rows: stats.daily.map((d) => ({
              label: formatDate(d.day, { day: "numeric", month: "short" }),
              long: formatDate(d.day, { weekday: "long", day: "numeric", month: "long" }),
              values: d,
            })),
            everyNth: 7,
            width: 680,
            height: 180,
          }),
        );
        if (stats.unknownObjects.length) {
          const things = stats.unknownObjects.slice(0, 3).map((o) => o.label);
          host.append(h("p", { class: "note" }, `Also looked at ${things.join(", ")}. `, h("a", { href: "#/memories?add=1" }, "Add a memory")));
        }

        let label = null;
        let group = null;
        for (const item of items) {
          const next = dayLabel(item.at);
          if (next !== label) {
            label = next;
            group = h("ol", null);
            host.append(h("section", { class: "day" }, h("h2", { class: "day__label" }, label), group));
          }
          group.append(h("li", { class: "event" }, item.at ? h("time", { datetime: item.at }, formatTime(item.at)) : h("time", null), h("p", null, item.text)));
        }
        if (items.length >= limit) {
          host.append(h("p", null, h("button", { type: "button", class: "link", onclick: () => ((limit += PAGE), load()) }, "Show earlier")));
        }
      },
    );
  load();

  return h("div", { class: "page" }, heading, host);
}
