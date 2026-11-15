// Small charts drawn as inline SVG: bar charts, and a heart-rate trace. Black and grey only. Each chart carries the same
// numbers in a table for screen readers, and shows a bar's values on hover or keyboard focus.
import { h, uid } from "./dom.js";

const niceMax = (value) => {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return value;
};

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/**
 * Heart rate across the time one memory was open: the trace, a dashed line at the resting rate,
 * and the peak marked when there was a rise. The sentence beside it says the same in words.
 *
 * @param {{ title: string, samples: number[], everySec: number, restingBpm: number,
 *           peak?: {bpm: number, atSec: number} | null, height?: number, width?: number }} options
 */
export function heartChart({ title, samples, everySec, restingBpm, peak = null, height = 150, width = 640 }) {
  if (window.innerWidth < 760) width = Math.min(width, 340);
  const pad = { top: 16, right: 12, bottom: 22, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  // Always at least 20 beats tall, so a steady trace looks steady instead of filling the box.
  const low = Math.min(restingBpm, ...samples);
  const high = Math.max(restingBpm, ...samples);
  const spare = Math.max(4, (20 - (high - low)) / 2);
  const min = Math.floor((low - spare) / 5) * 5;
  const max = Math.ceil((high + spare) / 5) * 5;
  const length = Math.max(1, (samples.length - 1) * everySec);
  const x = (seconds) => pad.left + (seconds / length) * innerW;
  const y = (bpm) => pad.top + innerH - ((bpm - min) / (max - min)) * innerH;

  const svg = h("svg", { class: "chart__svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title });
  for (const tick of [min, max]) {
    svg.append(
      h("line", { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), class: "chart__grid" }),
      h("text", { x: pad.left - 8, y: y(tick) + 4, class: "chart__tick", "text-anchor": "end" }, String(tick)),
    );
  }
  svg.append(
    h("line", { x1: pad.left, x2: width - pad.right, y1: y(restingBpm), y2: y(restingBpm), class: "chart__rest" }),
    h("text", { x: width - pad.right, y: y(restingBpm) + (peak ? 14 : -6), class: "chart__tick", "text-anchor": "end" }, `Resting ${restingBpm}`),
    h("polyline", { class: "chart__trace", points: samples.map((bpm, i) => `${x(i * everySec).toFixed(1)},${y(bpm).toFixed(1)}`).join(" ") }),
    h("text", { x: pad.left, y: height - 6, class: "chart__tick" }, "0:00"),
    h("text", { x: width - pad.right, y: height - 6, class: "chart__tick", "text-anchor": "end" }, clock(length)),
  );
  if (peak) {
    const px = x(Math.min(peak.atSec, length));
    svg.append(
      h("circle", { cx: px, cy: y(peak.bpm), r: 4.5, class: "chart__peak" }),
      h("text", { x: px, y: y(peak.bpm) - 9, class: "chart__tick chart__tick--strong", "text-anchor": px > width - 60 ? "end" : px < pad.left + 30 ? "start" : "middle" }, String(peak.bpm)),
    );
  }
  return h("figure", { class: "chart" }, svg);
}

/**
 * @param {{
 *   title: string,
 *   series:{key: string, name: string, tone: "ink"|"mid"}[],
 *   rows: {label: string, long: string, values: Record<string, number>}[],
 *   height?: number,
 *   width?: number,      // drawing width; choose it near the size the chart is shown at
 *   everyNth?: number,   // show every nth x label
 * }} options
 */
export function barChart({ title, series, rows, height = 180, width = 640, everyNth = 1 }) {
  // On a phone every chart is about 320px wide, so draw at that size to keep the labels legible.
  if (window.innerWidth < 760) width = Math.min(width, 340);
  const pad = { top: 8, right: 4, bottom: 22, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totals = rows.map((row) => series.reduce((sum, s) => sum + (row.values[s.key] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const slot = innerW / rows.length;
  const barW = Math.max(3, Math.min(34, slot * 0.62));
  const y = (value) => pad.top + innerH - (value / max) * innerH;

  const readout = h("p", { class: "chart__readout", "aria-hidden": "true" }, " ");
  const describe = (row) => `${row.long}: ${series.map((s) => `${row.values[s.key] ?? 0} ${s.name.toLowerCase()}`).join(", ")}`;

  const svg = h("svg", { class: "chart__svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title });
  for (const tick of [0, max / 2, max]) {
    svg.append(
      h("line", { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), class: "chart__grid" }),
      h("text", { x: pad.left - 8, y: y(tick) + 4, class: "chart__tick", "text-anchor": "end" }, String(Math.round(tick))),
    );
  }
  rows.forEach((row, index) => {
    const x = pad.left + slot * index + (slot - barW) / 2;
    let base = 0;
    const group = h("g", {
      class: "chart__bar",
      tabindex: "0",
      role: "img",
      "aria-label": describe(row),
      onmouseenter: () => (readout.textContent = describe(row)),
      onmouseleave: () => (readout.textContent = " "),
      onfocus: () => (readout.textContent = describe(row)),
      onblur: () => (readout.textContent = " "),
    });
    // A full-height invisible target so thin or empty bars can still be pointed at.
    group.append(h("rect", { x: pad.left + slot * index, y: pad.top, width: slot, height: innerH, fill: "transparent" }));
    for (const s of series) {
      const value = row.values[s.key] ?? 0;
      if (value > 0) {
        const top = y(base + value);
        group.append(h("rect", { x, y: top, width: barW, height: y(base) - top, rx: 2, class: `chart__fill chart__fill--${s.tone}` }));
      }
      base += value;
    }
    svg.append(group);
    if (index % everyNth === 0) {
      svg.append(h("text", { x: pad.left + slot * index + slot / 2, y: height - 6, class: "chart__tick", "text-anchor": "middle" }, row.label));
    }
  });

  const tableId = uid("chart-data");
  return h(
    "figure",
    { class: "chart" },
    series.length > 1
      ? h(
          "ul",
          { class: "chart__legend" },
          series.map((s) => h("li", null, h("span", { class: `swatch swatch--${s.tone}`, "aria-hidden": "true" }), s.name)),
        )
      : null,
    svg,
    readout,
    // Wrapped, because a table ignores the 1px box that hides it and would widen the page.
    h(
      "div",
      { class: "visually-hidden" },
      h(
      "table",
      { id: tableId },
      h("caption", null, title),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "When"), series.map((s) => h("th", { scope: "col" }, s.name)))),
      h("tbody", null, rows.map((row) => h("tr", null, h("th", { scope: "row" }, row.long), series.map((s) => h("td", null, String(row.values[s.key] ?? 0)))))),
    ),
    ),
  );
}
