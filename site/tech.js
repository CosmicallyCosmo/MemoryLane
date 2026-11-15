// The technology page: the architecture diagram, the recognition sandbox, the measured results
// and the memory lane editor, whose Cloudinary address is built the way the server builds it.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const press = (group, button) => group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));

  // ---- Architecture -------------------------------------------------------------------------
  const NODES = {
    glasses: {
      title: "Glasses",
      text: "Meta AI glasses: Ray-Ban Display, or audio-only. The camera, display, microphone and speakers belong to the glasses; the app runs on the phone.",
      points: ["The lens shows bare text and at most two choices", "Black is see-through: nothing covers the world", "Taking them off pauses everything"],
    },
    phone: {
      title: "Phone app · android/",
      text: "Kotlin and Jetpack Compose on Meta's Wearables Device Access Toolkit 1.0.1 (camera, display, speech, motion).",
      points: ["Keeps an offline pack: memories, recordings, hellos and answers", "Matches questions by wording when there's no connection", "“Use simulated glasses” runs on Meta's Mock Device Kit", "android/e2e/ drives the whole loop: 21 checks"],
    },
    server: {
      title: "Server · server/",
      text: "Node 22 and Express. Memories, family profiles, recognition, questions and answers, notifications and pairing.",
      points: ["Refuses to look at a frame until consent is recorded", "Frames are checked and discarded; only outcomes are logged", "Makes films in the background and serves the family app", "95 tests · npm run scorecard for recognition"],
    },
    family: {
      title: "Family app · family/",
      text: "A phone-first web app in plain JavaScript, built with Vite and served by the server. Home, Memories and Family.",
      points: ["Questions waiting, answers given, memories opened most", "Record a message; Gemini drafts the transcript to check", "Edit a memory lane in words, and undo any change"],
    },
    gemini: {
      title: "Gemini API · server/src/gemini.js",
      text: "Four jobs, one small REST client. JSON against a schema at temperature 0, so the model can only return a choice or a plan.",
      points: ["Decisions API (gemini-decision-1) for which memory is in view", "gemini-3.5-flash-lite, then gemini-3.1-flash-lite, within a deadline", "Hears the voice message to time a memory lane", "gemini-3.1-flash-image makes look-alikes for each memory's self-test"],
    },
    cloudinary: {
      title: "Cloudinary · server/src/cloudinary.js, films.js",
      text: "The whole path from a family's phone photos to a 264 × 264 silent film for the lens. A film is a single transformation URL.",
      points: ["fl_splice fades, e_zoompan, c_crop around the subject", "g_auto:faces for hellos, so_auto for tiles", "Eager display copies at upload; deletes are real"],
    },
  };
  const detail = document.getElementById("arch-detail");
  function showNode(key) {
    const n = NODES[key];
    document.querySelectorAll("#arch .node").forEach((g) => g.classList.toggle("is-on", g.dataset.node === key));
    detail.innerHTML = `<h3>${esc(n.title)}</h3><p>${esc(n.text)}</p><ul>${n.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
  }
  document.querySelectorAll("#arch .node").forEach((g) => {
    g.addEventListener("click", () => showNode(g.dataset.node));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showNode(g.dataset.node);
      }
    });
  });
  if (detail) showNode("server");

  // ---- Recognition sandbox -----------------------------------------------------------------
  // Illustrative numbers; the shape is the Decisions response the server reads.
  const FRAMES = {
    real: { probs: { k_teapot: 0.93, k_wedding: 0.02, k_mug: 0.01, other: 0.04 }, same: 0.96, checks: "lid knob: yes · flower panel: yes" },
    blur: { probs: { k_teapot: 0.71, k_wedding: 0.03, k_mug: 0.02, other: 0.24 }, same: 0.83, checks: "lid knob: unseen · flower panel: yes" },
    lookalike: { probs: { k_teapot: 0.86, k_wedding: 0.01, k_mug: 0.01, other: 0.12 }, same: 0.07, checks: "flower panel: no (stripes instead)" },
    mug: { probs: { k_teapot: 0.06, k_wedding: 0.02, k_mug: 0.04, other: 0.88 }, same: null, label: "a yellow striped mug" },
  };
  const NAMES = { k_teapot: "Mum's teapot", k_wedding: "Wedding photo", k_mug: "Fishing mug", other: "other (none)" };
  let frame = "real";
  let confirm = true;
  const probs = document.getElementById("probs");
  const verdict = document.getElementById("verdict");
  function renderFrame() {
    if (!probs) return;
    const f = FRAMES[frame];
    const top = Object.entries(f.probs).sort((a, b) => b[1] - a[1])[0];
    probs.innerHTML = Object.entries(f.probs)
      .map(([k, v]) => `<div class="prob${k === top[0] ? " is-top" : ""}"><span>${NAMES[k]}</span><div class="bar"><i style="--v:${v}"></i></div><b>${v.toFixed(2)}</b></div>`)
      .join("");
    let text;
    let miss = true;
    if (top[0] === "other") text = `<b>No match.</b> “other” wins. Gemini vision names it, <i>${f.label}</i>, and that goes to the family as an idea.`;
    else if (top[1] < 0.6) text = `<b>No match.</b> ${top[1].toFixed(2)} is under the 0.6 threshold.`;
    else if (!confirm) {
      miss = false;
      text = `<b>Offered: ${NAMES[top[0]]}.</b> No confirmation step, so ${top[1].toFixed(2)} is enough${frame === "lookalike" ? ", and the wrong teapot gets offered" : ""}.`;
    } else if (f.same < 0.6) text = `<b>Turned down at confirmation.</b> Same physical object? ${f.same.toFixed(2)}. ${f.checks}.`;
    else {
      miss = false;
      text = `<b>Offered: ${NAMES[top[0]]}.</b> Confirmed against that memory alone: same ${f.same.toFixed(2)} · ${f.checks}.`;
    }
    verdict.className = `threshold${miss ? " is-miss" : ""}`;
    verdict.innerHTML = text;
  }
  const frames = document.getElementById("frames");
  frames?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-frame]");
    if (!b) return;
    frame = b.dataset.frame;
    press(frames, b);
    renderFrame();
  });
  document.querySelector("[data-confirm]")?.parentElement.addEventListener("click", (e) => {
    const b = e.target.closest("[data-confirm]");
    if (!b) return;
    confirm = b.dataset.confirm === "on";
    press(b.parentElement, b);
    renderFrame();
  });
  renderFrame();

  // ---- Measured results ---------------------------------------------------------------------
  const resToggle = document.getElementById("res-toggle");
  resToggle?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-res]");
    if (!b) return;
    press(resToggle, b);
    const key = b.dataset.res;
    document.querySelectorAll("#results .result-row").forEach((row) => {
      const bar = row.querySelector("i");
      bar.style.setProperty("--v", bar.dataset[key]);
      row.querySelector("b").textContent = row.querySelector("b").dataset[key];
    });
  });

  // ---- Memory lane editor ------------------------------------------------------------------
  // Ported from server/src/cloudinary.js so the address is the one the server would make.
  const LENS = { width: 264, height: 264 };
  const SIZE = `h_${LENS.height},w_${LENS.width}`;
  const SILENT_MP4 = "ac_none,vc_h264,q_auto";
  const FADE = 1.5;
  const OPENING = 1.6;
  const SPLICE = `fl_splice:transition_(name_fade;du_${FADE})`;
  const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

  function filmSeconds(shots, voiceSeconds) {
    const least = 4;
    const total = Math.max(voiceSeconds, shots.length * least);
    const starts = shots.map((s) => s.at);
    const end = Math.max(total, starts.at(-1) + least);
    return shots.map((_, i) => round(Math.max(least, (i + 1 < shots.length ? starts[i + 1] : end) - starts[i]) + FADE, 1));
  }
  function cropAround({ width, height }, [fx, fy]) {
    const shape = LENS.width / LENS.height;
    let w = width;
    let h = Math.round(width / shape);
    if (h > height) {
      h = height;
      w = Math.round(height * shape);
    }
    const x = Math.round(Math.min(width - w, Math.max(0, fx * width - w / 2)));
    const y = Math.round(Math.min(height - h, Math.max(0, fy * height - h / 2)));
    return { x, y, w, h };
  }
  function startZoom({ width, height }, [fx, fy]) {
    const shape = LENS.width / LENS.height;
    const wider = width / height >= shape;
    const slackX = 0.3 * (wider ? (shape * height) / width : 1);
    const slackY = 0.3 * (wider ? 1 : width / shape / height);
    const off = Math.max(0, Math.abs(fx - 0.5) - slackX / 2, Math.abs(fy - 0.5) - slackY / 2);
    return 1 / (1 - 2 * off);
  }
  // Each part is [class, text] so the address can be coloured by what each piece does.
  function photoLayer(shot, last) {
    const focus = shot.focus;
    const seconds = round(shot.seconds, 1);
    const zoom = startZoom(shot, focus);
    const layer = ["u-fade", `${SPLICE},l_${shot.id.replaceAll("/", ":")}`];
    if (last && shot.motion !== "still" && zoom <= 1.4) {
      const at = `x_${round(focus[0])};y_${round(focus[1])}`;
      return [layer, ["u-zoom", `e_zoompan:du_${seconds};fps_25;from_(zoom_${round(zoom)};${at});to_(zoom_${round(zoom + 0.18)};${at})`], ["u-crop", `c_fill,${SIZE}`], ["u-fade", "fl_layer_apply"]];
    }
    const { x, y, w, h } = cropAround(shot, focus);
    return [layer, ["u-du", `du_${seconds}`], ["u-crop", `c_crop,h_${h},w_${w},x_${x},y_${y}`], ["u-crop", `c_scale,${SIZE}`], ["u-fade", "fl_layer_apply"]];
  }
  function filmParts(shots) {
    return [
      ["u-base", "https://res.cloudinary.com/<cloud>/video/upload"],
      ["u-du", `du_${OPENING}`],
      ["u-crop", `c_fill,${SIZE}`],
      ...shots.flatMap((s, i) => photoLayer(s, i === shots.length - 1)),
      ["u-out", SILENT_MP4],
      ["u-base", "memorylane/blank.mp4"],
    ];
  }

  const VOICE = 24;
  const PHOTOS = {
    graduation: { id: "memorylane/k_lane/graduation", width: 2400, height: 1600, focus: [0.5, 0.4], label: "Graduation", word: "the day you graduated", heard: 1 },
    beach: { id: "memorylane/k_lane/beach", width: 3000, height: 2000, focus: [0.64, 0.62], label: "The beach", word: "that week by the sea", heard: 7 },
    wedding: { id: "memorylane/k_lane/wedding", width: 1600, height: 2400, focus: [0.5, 0.33], label: "Wedding", word: "your wedding day", heard: 13 },
    cake: { id: "memorylane/k_lane/cake", width: 2000, height: 2000, focus: [0.5, 0.45], label: "Seventieth", word: "your seventieth", heard: 19 },
  };
  const SCENE = {
    graduation: `<svg viewBox="0 0 150 100" preserveAspectRatio="xMidYMid slice"><rect width="150" height="100" fill="#dfe9ff"/><rect y="70" width="150" height="30" fill="#b9d3a5"/><circle cx="75" cy="40" r="7" fill="#0e343f"/><path d="M66 70v-14a9 9 0 0 1 18 0v14z" fill="#0e343f"/><path d="M63 34l12-6 12 6-12 6z" fill="#0e343f"/></svg>`,
    beach: `<svg viewBox="0 0 150 100" preserveAspectRatio="xMidYMid slice"><rect width="150" height="100" fill="#9fd8f0"/><circle cx="30" cy="24" r="9" fill="#ffd27a"/><rect y="54" width="150" height="18" fill="#45c3cf"/><path d="M0 70Q75 62 150 70V100H0z" fill="#f3dfb4"/><circle cx="96" cy="58" r="4" fill="#15586a"/><path d="M91 80v-10a5 5 0 0 1 10 0v10z" fill="#15586a"/></svg>`,
    wedding: `<svg viewBox="0 0 150 100" preserveAspectRatio="xMidYMid slice"><rect width="150" height="100" fill="#f4ecf7"/><path d="M40 100V60q35-40 70 0v40z" fill="#fff"/><circle cx="66" cy="38" r="6" fill="#0e343f"/><path d="M59 80v-26a7 7 0 0 1 14 0v26z" fill="#0e343f"/><circle cx="84" cy="38" r="6" fill="#c08a6b"/><path d="M74 82l4-28a6 6 0 0 1 12 0l4 28z" fill="#fff" stroke="#e5dbe9"/></svg>`,
    cake: `<svg viewBox="0 0 150 100" preserveAspectRatio="xMidYMid slice"><rect width="150" height="100" fill="#fbe3ea"/><rect y="66" width="150" height="34" fill="#c99a6b"/><rect x="50" y="44" width="50" height="24" rx="4" fill="#fff8ee"/><rect x="50" y="52" width="50" height="5" fill="#f3a6b8"/><path d="M62 44v-8M75 44v-8M88 44v-8" stroke="#45c3cf" stroke-width="2"/></svg>`,
  };
  const BASE = {
    order: [
      { key: "graduation", at: 0 },
      { key: "beach", at: 7 },
      { key: "wedding", at: 13 },
      { key: "cake", at: 19 },
    ],
    lastMotion: "push-in",
    note: "I placed each photo where Sarah mentions it: the graduation with her opening words, the beach at “that week by the sea”, and a slow move in on the seventieth to end.",
  };
  const EDITS = {
    wedding: (p) => ({
      ...p,
      order: [{ key: "wedding", at: 0 }, { key: "graduation", at: 5 }, { key: "beach", at: 9 }, { key: "cake", at: 19 }],
      note: "I moved the wedding to the start, as you asked, and drew the graduation and the beach a little later so each still lands near where Sarah mentions it.",
    }),
    beach: (p) => {
      const order = p.order.map((s) => ({ ...s }));
      const i = order.findIndex((s) => s.key === "beach");
      if (order[i + 1]) order[i + 1].at = Math.min(order[i + 1].at + 5, (order[i + 2]?.at ?? VOICE) - 4);
      return { ...p, order, note: "I kept the beach on screen longer by starting the next photo later. Everything else is as it was." };
    },
    still: (p) => ({ ...p, lastMotion: "still", note: "The last photo now stays still instead of moving slowly in." }),
  };
  let plan = BASE;
  const history = [];

  const shotsEl = document.getElementById("shots");
  const wordsEl = document.getElementById("words");
  const urlEl = document.getElementById("url");
  const noteEl = document.getElementById("lane-note");
  const undo = document.querySelector('[data-req="undo"]');
  let lastUrlParts = [];

  function drawWave() {
    const svg = document.getElementById("wave");
    if (!svg) return;
    let d = "";
    for (let x = 0; x < 400; x += 3) {
      const t = x / 400;
      const speech = Math.abs(Math.sin(t * 61) * Math.sin(t * 13 + 1) * Math.cos(t * 7));
      const gap = [0.27, 0.52, 0.77].some((g) => Math.abs(t - g) < 0.02) ? 0.08 : 1;
      const h = Math.max(2, 46 * speech * gap);
      d += `M${x} ${27 - h / 2}v${h}`;
    }
    svg.innerHTML = `<path d="${d}" stroke="#45c3cf" stroke-width="1.8" stroke-linecap="round" opacity=".75"/>`;
  }

  function render(changed) {
    if (!shotsEl) return;
    const shots = plan.order.map((s, i) => ({ ...PHOTOS[s.key], key: s.key, at: s.at, type: "image", motion: i === plan.order.length - 1 ? plan.lastMotion : "still" }));
    const seconds = filmSeconds(shots, VOICE);
    shots.forEach((s, i) => (s.seconds = seconds[i]));
    const end = Math.max(VOICE, shots.at(-1).at + 4);
    document.getElementById("axis-end").textContent = `${end} s`;

    // Thumbnails, keyed so moves animate.
    for (const s of shots) {
      let el = shotsEl.querySelector(`[data-key="${s.key}"]`);
      if (!el) {
        el = document.createElement("div");
        el.className = "shot";
        el.dataset.key = s.key;
        el.innerHTML = `${SCENE[s.key]}<span></span>`;
        shotsEl.append(el);
      }
      const next = shots[shots.indexOf(s) + 1]?.at ?? end;
      el.style.left = `${(s.at / end) * 100}%`;
      el.style.width = `calc(${((next - s.at) / end) * 100}% - 4px)`;
      el.querySelector("span").textContent = `${s.label} · ${s.seconds}s${s.motion === "push-in" ? " · move in" : ""}`;
    }
    wordsEl.innerHTML = Object.values(PHOTOS)
      .map((p) => `<span style="left:${(p.heard / end) * 100}%">“${esc(p.word)}”</span>`)
      .join("");

    const parts = filmParts(shots);
    urlEl.innerHTML = parts
      .map(([cls, text], i) => `<span class="${cls}${changed && lastUrlParts[i] !== text ? " is-flash" : ""}">${esc(text)}</span>`)
      .join("/");
    lastUrlParts = parts.map((p) => p[1]);
    setTimeout(() => urlEl.querySelectorAll(".is-flash").forEach((s) => s.classList.remove("is-flash")), 1400);

    noteEl.innerHTML = `<b>Gemini's note to the family:</b> ${esc(plan.note)}`;
    if (undo) {
      undo.disabled = !history.length;
      undo.style.opacity = history.length ? "1" : ".5";
    }
    renderPreview(shots);
  }

  document.getElementById("asks")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-req]");
    if (!b || b.disabled) return;
    if (b.dataset.req === "undo") plan = history.pop() ?? BASE;
    else {
      history.push(plan);
      plan = EDITS[b.dataset.req](plan);
    }
    render(true);
  });

  // ---- Preview: the film, square, as the lens would play it --------------------------------
  const pfilm = document.getElementById("pfilm");
  const playhead = document.getElementById("playhead");
  let previewTimers = [];
  function renderPreview(shots) {
    if (!pfilm) return;
    previewTimers.forEach(clearTimeout);
    previewTimers = [];
    playhead.getAnimations().forEach((a) => a.cancel());
    playhead.style.opacity = 0;
    pfilm.innerHTML = shots
      .map((s, i) => {
        const fx = `${s.focus[0] * 100}%`;
        const fy = `${s.focus[1] * 100}%`;
        return `<div class="film__shot${i === 0 ? " is-on" : ""}${s.motion === "push-in" ? "" : " is-still"}" style="--fx:${fx};--fy:${fy};--du:${s.seconds}s">${SCENE[s.key]}</div>`;
      })
      .join("");
    pfilm._shots = shots;
  }
  document.getElementById("preview")?.addEventListener("click", () => {
    const shots = pfilm._shots;
    renderPreview(shots);
    const end = Math.max(VOICE, shots.at(-1).at + 4);
    const speed = reduced ? 0.02 : 0.35; // a 24 s message previews in about 8 s
    const els = pfilm.querySelectorAll(".film__shot");
    els.forEach((el) => el.classList.remove("is-on"));
    playhead.style.opacity = 1;
    playhead.animate([{ left: "0%" }, { left: "100%" }], { duration: end * 1000 * speed, easing: "linear", fill: "forwards" });
    shots.forEach((s, i) =>
      previewTimers.push(
        setTimeout(() => {
          els.forEach((el, j) => el.classList.toggle("is-on", j === i));
          if (s.motion === "push-in") els[i].style.setProperty("--du", `${(end - s.at) * speed}s`);
        }, s.at * 1000 * speed),
      ),
    );
    previewTimers.push(setTimeout(() => (playhead.style.opacity = 0), end * 1000 * speed + 400));
  });

  drawWave();
  render(false);
})();
