// A memory's lane: its photos and video as a slow film, with the family's voice message and
// quiet music. Shown at the top of the memory's page, watched here or on the phone, and copied
// to the glasses.
import { api } from "../api.js";
import { clear, field, h, statusLine, uid } from "../dom.js";
import { canMakeLensCopy, makeLensCopy } from "../lane/lens.js";
import { createLanePlayer } from "../lane/player.js";

const MUSIC = { warm: "Warm piano and strings", tender: "Tender and slow", bright: "Light and bright", none: "No music" };
const AMBIENCE = { none: "Nothing else", waves: "A calm sea", breeze: "A gentle breeze" };
const PACE = { gentle: "Gentle", slower: "Slower" };

const clock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const minutes = (seconds) => (seconds < 90 ? "about a minute" : `about ${Math.round(seconds / 60)} minutes`);

/**
 * The film and everything to change about it. `makeLens`: start making the glasses copy
 * straight away, as when the memory has just been added.
 */
export function lanePanel(memory, { onCleanup, makeLens = false }) {
  const host = h("div", { class: "stack" });
  let player = null;
  let lensAbort = null;
  let lensPoll = 0;
  let resize = null;
  const stop = () => {
    lensAbort?.abort();
    lensAbort = null;
    clearTimeout(lensPoll);
    resize?.disconnect();
    resize = null;
    player?.destroy();
    player = null;
  };
  onCleanup(stop);

  const render = (lane) => {
    stop();
    clear(host).append(...panel(lane));
  };

  function panel(lane) {
    const canvas = h("canvas", { role: "img", "aria-label": `Memory lane: ${memory.name}` });
    const stage = h("div", { class: "lane-stage" }, canvas);
    const bigPlay = h("button", { type: "button", class: "lane-stage__play", "aria-label": "Play" }, "▶");
    stage.append(bigPlay);
    const playButton = h("button", { type: "button", class: "btn btn--primary", disabled: true }, "Play");
    const scrub = h("input", { type: "range", min: 0, max: 1, step: 0.1, value: 0, class: "lane-controls__scrub", "aria-label": "Position", disabled: true });
    const time = h("span", { class: "lane-controls__time muted" }, "Loading…");
    const full = h("button", { type: "button", class: "btn" }, "Full screen");
    const stageStatus = statusLine();

    const sizeCanvas = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(stage.clientWidth * ratio);
      canvas.height = Math.round(stage.clientHeight * ratio);
      player?.redraw();
    };
    resize = new ResizeObserver(sizeCanvas);
    resize.observe(stage);
    sizeCanvas();

    const showState = () => {
      const on = player?.playing;
      playButton.textContent = on ? "Pause" : "Play";
      bigPlay.hidden = Boolean(on);
    };
    const toggle = async () => {
      if (!player) return;
      if (player.playing) player.pause();
      else await player.play();
      showState();
    };
    playButton.addEventListener("click", toggle);
    bigPlay.addEventListener("click", toggle);
    canvas.addEventListener("click", toggle);
    scrub.addEventListener("input", () => player?.seek(Number(scrub.value)));
    full.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.()));

    createLanePlayer({
      canvas,
      lane,
      onTime: (t) => {
        if (document.activeElement !== scrub) scrub.value = String(t);
        time.textContent = `${clock(t)} / ${clock(player?.duration ?? 0)}`;
      },
      onEnd: showState,
    })
      .then((made) => {
        if (!host.contains(canvas)) return made.destroy();
        player = made;
        scrub.max = String(made.duration);
        scrub.disabled = false;
        playButton.disabled = false;
        time.textContent = `0:00 / ${clock(made.duration)}`;
        made.redraw();
        lensDuration.textContent = minutes(made.duration);
      })
      .catch((error) => {
        time.textContent = "";
        stageStatus.error(error.message);
      });

    // Changing it in words.
    const words = h("textarea", { rows: 2, maxLength: 300, placeholder: "Slower, and start with the beach." });
    const changeStatus = statusLine();
    const change = h("button", { type: "submit", class: "btn btn--primary" }, "Change it");
    const undo = lane.canUndo ? h("button", { type: "button", class: "btn" }, "Undo") : null;
    const busy = (on) => [change, undo, words].forEach((el) => el && (el.disabled = on));
    const changeForm = h(
      "form",
      {
        class: "form",
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          const asked = words.value.trim();
          if (!asked) {
            changeStatus.error("Say what to change.");
            words.focus();
            return;
          }
          busy(true);
          changeStatus.set("Changing… this can take a minute.");
          try {
            render(await api.reviseLane(memory.id, asked));
          } catch (error) {
            busy(false);
            changeStatus.error(error.message);
          }
        },
      },
      field({
        label: "What should change?",
        control: words,
      }),
      changeStatus.el,
      h("div", { class: "row" }, change, undo),
    );
    undo?.addEventListener("click", async () => {
      busy(true);
      try {
        render(await api.undoLane(memory.id));
      } catch (error) {
        busy(false);
        changeStatus.error(error.message);
      }
    });

    // Changing the sound and the pace by hand, no model needed.
    const select = (options, value, key) => {
      const control = h(
        "select",
        { id: uid("lane") },
        Object.entries(options).map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
      );
      control.addEventListener("change", async () => {
        control.disabled = true;
        try {
          render(await api.updateLane(memory.id, { [key]: control.value }));
        } catch (error) {
          control.disabled = false;
          changeStatus.error(error.message);
        }
      });
      return control;
    };

    // The copy the glasses play.
    const lensDuration = h("span", null, "as long as the memory lane");
    const lensStatus = statusLine();
    const progress = h("progress", { max: 1, value: 0, class: "progress", hidden: true, "aria-label": "Glasses copy progress" });
    const idleLabel = lane.lens ? "Update it on the glasses" : "Put it on the glasses";
    const lensButton = h("button", { type: "button", class: "btn" }, idleLabel);
    const lensState = !lane.lens
      ? "Not on the glasses yet."
      : lane.lens.version === lane.version
        ? "On the glasses, up to date."
        : "The glasses have an older version.";
    const makeCopy = async () => {
      if (lensAbort) {
        lensAbort.abort();
        return;
      }
      player?.pause();
      showState();
      const abort = new AbortController();
      lensAbort = abort;
      lensButton.textContent = "Stop";
      progress.hidden = false;
      progress.value = 0;
      lensStatus.set("Preparing. Keep this page open.");
      try {
        const copy = await makeLensCopy(lane, { signal: abort.signal, onProgress: (f) => (progress.value = f) });
        lensStatus.set("Sending…");
        render(await api.uploadLaneLens(memory.id, { ...copy, version: lane.version }));
      } catch (error) {
        if (lensAbort !== abort) return;
        lensAbort = null;
        progress.hidden = true;
        lensButton.textContent = idleLabel;
        if (abort.signal.aborted) lensStatus.clear();
        else lensStatus.error(error.message);
      }
    };
    lensButton.addEventListener("click", makeCopy);
    if (makeLens && !lane.lens && canMakeLensCopy()) {
      makeLens = false;
      queueMicrotask(makeCopy);
    }

    return [
      stage,
      h("div", { class: "lane-controls" }, playButton, scrub, time, full),
      stageStatus.el,
      lane.note ? h("p", { class: "muted" }, lane.note) : null,
      h(
        "section",
        { class: "section" },
        h("h2", null, "On the glasses"),
        h("p", null, lensState),
        canMakeLensCopy()
          ? h("p", { class: "muted small" }, "Takes ", lensDuration, ".")
          : h("p", { class: "muted" }, "Open this page in Chrome or Edge to do this."),
        canMakeLensCopy() ? h("div", { class: "row" }, lensButton) : null,
        progress,
        lensStatus.el,
      ),
      h("section", { class: "section" }, h("h2", null, "Edit the memory lane"), changeForm),
      h(
        "section",
        { class: "section" },
        h("h2", null, "Music and pace"),
        h(
          "div",
          { class: "lane-settings" },
          field({ label: "Music", control: select(MUSIC, lane.music, "music") }),
          field({ label: "Sound around it", control: select(AMBIENCE, lane.ambience, "ambience") }),
          field({ label: "Pace", control: select(PACE, lane.pace, "pace") }),
        ),
      ),
    ];
  }

  render(memory.lane);
  return host;
}
