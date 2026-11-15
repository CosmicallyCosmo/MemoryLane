// The "Try it" demo on the home page: Jimmy's glasses on the left, Sarah's family app on the
// right, one shared household between them. Nothing is sent anywhere: the decisions shown in
// the trace have the shape of the real ones (server/src/gemini.js) with made-up numbers.
(() => {
  const room = document.getElementById("room");
  if (!room) return;
  const lens = document.getElementById("lens");
  const reticle = document.getElementById("reticle");
  const feed = document.getElementById("feed");
  const badge = document.getElementById("badge");
  const tracelog = document.getElementById("tracelog");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- Scenes for the films: square, like the display. ------------------------------------
  const sky = (a, b) => `<defs><linearGradient id="g${a.slice(1)}${b.slice(1)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g${a.slice(1)}${b.slice(1)})"/>`;
  const person = (x, y, s, c) => `<circle cx="${x}" cy="${y}" r="${4 * s}" fill="${c}"/><path d="M${x - 5 * s} ${y + 22 * s}v-10a${5 * s} ${5 * s} 0 0 1 ${10 * s} 0v10z" fill="${c}"/>`;
  const SCENES = {
    river: `<svg viewBox="0 0 100 100">${sky("#ffd9a8", "#ffefd9")}<circle cx="74" cy="30" r="9" fill="#ffb86b"/><path d="M0 58 Q 25 44 50 54 T 100 50 V100 H0z" fill="#8fc79a"/><path d="M0 72 Q 30 64 60 72 T 100 70 V84 Q 60 78 30 86 T 0 84z" fill="#6fb8c9"/>${person(36, 50, 0.9, "#15586a")}${person(46, 51, 0.85, "#2fa9b6")}</svg>`,
    tea: `<svg viewBox="0 0 100 100">${sky("#f6ead7", "#efdcc0")}<rect x="0" y="62" width="100" height="38" fill="#b98a5e"/><ellipse cx="50" cy="66" rx="44" ry="8" fill="#fff8ee"/><g transform="translate(26 30) scale(.4)"><use href="#ill-teapot" width="120" height="110"/></g><path d="M64 56h12v8a6 6 0 0 1-12 0z" fill="#fff"/><path d="M76 58a3 3 0 0 1 0 6" stroke="#fff" stroke-width="2" fill="none"/><path d="M70 50q2-4 0-8M72 50q2-4 0-8" stroke="#c9b9a6" stroke-width="1.2" fill="none"/></svg>`,
    sunday: `<svg viewBox="0 0 100 100">${sky("#cfe9ee", "#eef8f6")}<rect x="0" y="66" width="100" height="34" fill="#9fcf9a"/><rect x="14" y="36" width="34" height="30" fill="#fff8ee"/><path d="M10 38 L31 22 L52 38z" fill="#c0614b"/><rect x="26" y="50" width="9" height="16" fill="#8b5e3c"/>${person(66, 52, 1, "#15586a")}${person(78, 54, 0.9, "#45c3cf")}<circle cx="84" cy="20" r="7" fill="#f6d27a"/></svg>`,
    graduation: `<svg viewBox="0 0 100 100">${sky("#dfe9ff", "#f3f6ff")}<rect x="0" y="70" width="100" height="30" fill="#b9d3a5"/>${person(50, 42, 1.4, "#0e343f")}<path d="M38 34 L50 28 L62 34 L50 40z" fill="#0e343f"/><path d="M60 34v8" stroke="#f2b24c" stroke-width="1.5"/><rect x="58" y="60" width="10" height="4" rx="1" fill="#fff8ee"/></svg>`,
    beach: `<svg viewBox="0 0 100 100">${sky("#9fd8f0", "#e8f7fb")}<circle cx="24" cy="24" r="8" fill="#ffd27a"/><rect x="0" y="56" width="100" height="18" fill="#45c3cf"/><path d="M0 70 Q 50 62 100 70 V100 H0z" fill="#f3dfb4"/>${person(60, 60, 1, "#15586a")}${person(70, 63, 0.7, "#e9a23b")}</svg>`,
    cake: `<svg viewBox="0 0 100 100">${sky("#fbe3ea", "#fff6f8")}<rect x="0" y="66" width="100" height="34" fill="#c99a6b"/><rect x="28" y="44" width="44" height="24" rx="4" fill="#fff8ee"/><rect x="28" y="52" width="44" height="5" fill="#f3a6b8"/><path d="M40 44v-8M50 44v-8M60 44v-8" stroke="#45c3cf" stroke-width="2"/><circle cx="40" cy="34" r="1.8" fill="#ffb86b"/><circle cx="50" cy="34" r="1.8" fill="#ffb86b"/><circle cx="60" cy="34" r="1.8" fill="#ffb86b"/></svg>`,
  };

  // ---- The household -----------------------------------------------------------------------
  const MEMORIES = {
    teapot: {
      id: "k_teapot", name: "Turquoise teapot", from: "Sarah",
      shots: [
        { scene: "tea", at: 0, fx: "40%", fy: "50%" },
        { scene: "river", at: 4.5, fx: "42%", fy: "55%" },
        { scene: "sunday", at: 10, fx: "70%", fy: "60%" },
      ],
      lines: [
        [0, "Dad, this was Mum's teapot."],
        [4.5, "Every Sunday after your walk by the river, you two had tea from it."],
        [10, "You always said the second cup was the best one."],
      ],
      seconds: 15,
    },
    photo: {
      id: "k_sarah_photo", name: "Wedding photo", from: "Sarah",
      shots: [{ scene: "sunday", at: 0, fx: "70%", fy: "60%" }, { scene: "river", at: 6, fx: "42%", fy: "55%" }],
      lines: [[0, "This is you and Mum on your wedding day, Dad."], [6, "You danced by the river until it got dark."]],
      seconds: 11,
    },
    lane: {
      id: "p_sarah", name: "Sarah's memory lane", from: "Sarah",
      shots: [
        { scene: "graduation", at: 0, fx: "50%", fy: "40%" },
        { scene: "beach", at: 5, fx: "64%", fy: "62%" },
        { scene: "cake", at: 10, fx: "50%", fy: "45%" },
      ],
      lines: [[0, "My graduation. You drove us there."], [5, "Our week by the sea."], [10, "Your seventieth birthday."]],
      seconds: 15,
    },
  };
  const QUESTIONS = {
    margaret: { text: "Where's Margaret?", suggestion: "Margaret's at the hairdresser's this morning, Dad. She'll be home for lunch." },
    sarah: { text: "Is Sarah coming today?", suggestion: "I'm coming on Saturday, Dad, and I'm bringing the grandchildren." },
  };

  let state;
  let timers = [];
  // The phone's own timers: Jimmy looking at something must not stop Sarah recording.
  let phoneTimers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, reduced ? Math.min(ms, 300) : ms));
  const stopAll = () => { timers.forEach(clearTimeout); timers = []; room.classList.remove("is-playing"); };

  function fresh() {
    return {
      asked: { margaret: 0, sarah: 0 },
      answers: {},
      ideas: 0,
      opened: 0,
      cards: {},
    };
  }

  // ---- The trace: what the AI decided ---------------------------------------------------------
  function trace(who, label, json) {
    if (tracelog.firstElementChild?.querySelector(".who")?.textContent.startsWith("Waiting")) tracelog.innerHTML = "";
    const entry = document.createElement("div");
    entry.className = "trace__entry";
    entry.innerHTML = `<span class="who">${who}</span> · <b>${label}</b>${json ? `<pre>${escape(JSON.stringify(json, null, 2))}</pre>` : ""}`;
    tracelog.prepend(entry);
  }
  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---- The lens -----------------------------------------------------------------------------
  const heardEl = document.createElement("div");
  heardEl.className = "heard";
  heardEl.setAttribute("aria-live", "polite");
  room.append(heardEl);
  function hear(text) {
    heardEl.innerHTML = text ? `<small>Heard</small>${escape(text)}` : "";
    heardEl.classList.toggle("is-on", Boolean(text));
  }
  function showLens({ title, sub, quote, text, choices = [], playing, film, seconds, heard }) {
    lens.innerHTML = "";
    hear(heard);
    if (title) lens.insertAdjacentHTML("beforeend", `<div class="lens__title">${escape(title)}</div>`);
    if (sub) lens.insertAdjacentHTML("beforeend", `<div class="lens__sub">${escape(sub)}</div>`);
    if (film) lens.append(film);
    if (text) lens.insertAdjacentHTML("beforeend", `<div class="lens__text">${escape(text)}</div>`);
    if (quote) lens.insertAdjacentHTML("beforeend", `<div class="lens__quote">${escape(quote)}</div>`);
    if (playing) {
      lens.insertAdjacentHTML("beforeend", `<div class="lens__playing"><span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>${escape(playing)}</div><div class="progress"><i></i></div>`);
      const bar = lens.querySelector(".progress i");
      bar.animate([{ width: "0%" }, { width: "100%" }], { duration: (reduced ? 0.3 : seconds) * 1000, fill: "forwards", easing: "linear" });
    }
    if (choices.length) {
      const row = document.createElement("div");
      row.className = "lens__choices";
      choices.forEach((c, i) => {
        const b = document.createElement("button");
        b.className = `lens__btn${i === 0 ? " lens__btn--primary" : ""}`;
        b.textContent = c.label;
        b.addEventListener("click", c.on);
        row.append(b);
      });
      lens.append(row);
    }
    lens.classList.remove("is-hidden");
  }
  const hideLens = () => { lens.classList.add("is-hidden"); hear(""); };

  function aim(thing) {
    const r = room.getBoundingClientRect();
    const t = thing.getBoundingClientRect();
    reticle.style.left = `${t.left - r.left + t.width / 2}px`;
    reticle.style.top = `${t.top - r.top + t.height / 2}px`;
    reticle.classList.add("is-on");
  }
  const unaim = () => {
    reticle.classList.remove("is-on");
    room.querySelectorAll(".is-looking").forEach((el) => el.classList.remove("is-looking"));
  };

  // ---- A film, as the display would play it ------------------------------------------------
  function playFilm(memory, done) {
    const film = document.createElement("div");
    film.className = "film";
    memory.shots.forEach((shot, i) => {
      const next = memory.shots[i + 1]?.at ?? memory.seconds;
      const el = document.createElement("div");
      // As on the lens: only the last picture moves slowly in.
      el.className = `film__shot${i === memory.shots.length - 1 ? "" : " is-still"}`;
      el.style.setProperty("--fx", shot.fx);
      el.style.setProperty("--fy", shot.fy);
      el.style.setProperty("--du", `${next - shot.at + 1.5}s`);
      el.innerHTML = SCENES[shot.scene];
      film.append(el);
    });
    room.classList.add("is-playing");
    showLens({ title: memory.name, film, heard: memory.lines[0][1], playing: `${memory.from}'s recording`, seconds: memory.seconds, choices: [{ label: "Done", on: () => { stopAll(); hideLens(); } }] });
    const shots = film.querySelectorAll(".film__shot");
    memory.shots.forEach((shot, i) =>
      later(() => {
        shots.forEach((s, j) => s.classList.toggle("is-on", j === i));
      }, shot.at * 1000 + 30),
    );
    memory.lines.forEach(([at, line]) =>
      later(() => {
        hear(line);
      }, at * 1000),
    );
    later(() => {
      room.classList.remove("is-playing");
      done();
    }, memory.seconds * 1000);
  }

  // ---- The family app --------------------------------------------------------------------
  function waiting() {
    const n = Object.keys(QUESTIONS).filter((q) => state.asked[q] && !state.answers[q]).length + (state.ideas ? 1 : 0);
    badge.hidden = n === 0;
    if (String(n) !== badge.textContent) {
      badge.textContent = n;
      badge.classList.remove("is-bump");
      void badge.offsetWidth;
      badge.classList.add("is-bump");
    }
    document.getElementById("empty").hidden = Object.keys(state.cards).length > 0;
  }
  function card(key, html, cls = "") {
    let el = state.cards[key];
    if (!el) {
      el = document.createElement("div");
      state.cards[key] = el;
      document.getElementById("empty").after(el);
    } else {
      // Bring it to the top, as new news.
      document.getElementById("empty").after(el);
      el.style.animation = "none";
      void el.offsetWidth;
      el.style.animation = "";
    }
    el.className = `card ${cls}`;
    el.innerHTML = html;
    waiting();
    return el;
  }

  function questionCard(id) {
    const q = QUESTIONS[id];
    const n = state.asked[id];
    const el = card(
      `q:${id}`,
      `<div class="card__kicker">Dad asked <span class="count">${n} ${n === 1 ? "time" : "times"}</span> · nobody has answered yet</div>
       <p class="card__q">${escape(q.text)}</p>
       <div class="card__actions"><button class="btn" data-act="record">Record an answer</button><button class="btn btn--ghost" data-act="type">Type it</button></div>`,
    );
    el.querySelector('[data-act="record"]').onclick = () => record(id, el);
    el.querySelector('[data-act="type"]').onclick = () => typeAnswer(id, el);
  }

  function record(id, el) {
    const actions = el.querySelector(".card__actions");
    actions.outerHTML = `<div class="rec"><span class="rec__dot"></span><span>Recording… <span data-t>0:00</span></span></div>`;
    let s = 0;
    const tick = setInterval(() => {
      s++;
      const t = el.querySelector("[data-t]");
      if (t) t.textContent = `0:0${s}`;
    }, 700);
    phoneTimers.push(tick);
    phoneTimers.push(setTimeout(() => {
      clearInterval(tick);
      save(id, QUESTIONS[id].suggestion, "voice");
    }, reduced ? 300 : 2600));
  }

  function typeAnswer(id, el) {
    const actions = el.querySelector(".card__actions");
    actions.outerHTML = `<label class="visually-hidden" for="ta-${id}">Your answer</label><textarea id="ta-${id}">${escape(QUESTIONS[id].suggestion)}</textarea><div class="card__actions"><button class="btn" data-act="save">Save answer</button></div>`;
    const ta = el.querySelector("textarea");
    ta.focus();
    el.querySelector('[data-act="save"]').onclick = () => save(id, ta.value.trim() || QUESTIONS[id].suggestion, "typed");
  }

  function save(id, text, kind) {
    state.answers[id] = { id: `a_${Object.keys(state.answers).length + 1}`, text, kind };
    card(
      `q:${id}`,
      `<div class="card__kicker">Answered by you · ${kind === "voice" ? "voice recording" : "typed, read by a neutral voice"}</div>
       <p class="card__q">${escape(QUESTIONS[id].text)}</p>
       <p style="margin-top:8px;font-family:var(--serif);font-size:16px;color:var(--grey)">${escape(text)}</p>
       <p style="margin-top:10px;font-size:14px;color:var(--accent);font-weight:600">From now on, Dad hears this when he asks.</p>`,
      "card--done",
    );
    trace("Sarah's phone", "Answer saved", { question: QUESTIONS[id].text, answer_id: state.answers[id].id, kind, by: "Sarah" });
  }

  // ---- What Jimmy does -----------------------------------------------------------------------
  function look(name, thing) {
    stopAll();
    hideLens();
    unaim();
    thing.classList.add("is-looking");
    aim(thing);
    trace("Glasses", "Frame sent for a look", { frame: "1 JPEG, at most 768 px", server_limit_seconds: 12, trigger: "automatic look: offered, never played unasked" });
    later(() => decide(name), 1300);
  }

  function decide(name) {
    unaim();
    if (name === "teapot") {
      trace("Gemini Decisions", "Which memory is this?", { choice: "k_teapot", probabilities: { k_teapot: 0.94, k_sarah_photo: 0.01, other: 0.05 } });
      trace("Gemini Decisions", "Confirmed against that memory alone", { same: 0.97, threshold: 0.6, result: "match" });
      const m = MEMORIES.teapot;
      showLens({
        title: m.name, sub: `From ${m.from}`,
        choices: [
          { label: "See memory", on: () => openMemory(m) },
          { label: "Not now", on: () => { hideLens(); trace("Glasses", "Offer turned down. Nothing played."); } },
        ],
      });
    } else if (name === "photo") {
      trace("Gemini Decisions", "Which memory is this?", { choice: "k_sarah_photo", probabilities: { k_sarah_photo: 0.91, k_teapot: 0.02, other: 0.07 } });
      trace("Gemini Decisions", "Confirmed against that memory alone", { same: 0.95, threshold: 0.6, result: "match" });
      const hello = () => {
        trace("Glasses", "Who's that? The person the family said is in this photo", { person: "p_sarah", note: "from the object, never from a face" });
        showLens({ title: "Sarah", sub: "Daughter", heard: "Hi Dad, it's Sarah, your daughter. I'm coming to see you on Saturday.", playing: "Sarah's hello", seconds: 5, choices: [{ label: "See memory", on: () => openMemory(MEMORIES.photo) }, { label: "Done", on: hideLens }] });
        later(() =>
          showLens({
            title: "Memory lane", sub: "Walk through Sarah's memories?",
            heard: "Would you like to walk down memory lane with Sarah?",
            choices: [{ label: "Yes", on: () => openMemory(MEMORIES.lane) }, { label: "Not now", on: hideLens }],
          }), 5200);
      };
      showLens({
        title: "Wedding photo", sub: "From Sarah",
        heard: "There's a memory here from Sarah. Would you like to see it?",
        choices: [{ label: "See memory", on: () => openMemory(MEMORIES.photo) }, { label: "Who's that?", on: hello }],
      });
    } else {
      trace("Gemini Decisions", "Which memory is this?", { choice: "other", probabilities: { other: 0.88, k_teapot: 0.07, k_sarah_photo: 0.05 } });
      trace("Gemini", "No memory, so name it for the family", { match_id: "none", object_label: "a yellow striped mug" });
      showLens({ text: "I don't know this one yet", heard: "I don't have a memory about this yet. It looks like a yellow striped mug.", choices: [{ label: "Try again", on: () => look("mug", room.querySelector('[data-thing="mug"]')) }] });
      later(hideLens, 6000);
      state.ideas++;
      card(
        "idea",
        `<div class="card__kicker">An idea for a new memory</div><p>Dad looked at <b>a yellow striped mug</b> ${state.ideas === 1 ? "today" : `${state.ideas} times today`}. It holds no memory yet.</p><div class="card__actions"><button class="btn btn--ghost" data-act="add">Add a memory</button></div>`,
        "card--idea",
      ).querySelector('[data-act="add"]').onclick = (e) => { e.target.closest(".card__actions").innerHTML = `<span style="font-size:14px;color:var(--amber);font-weight:600">Opens “Add a memory” in the real app.</span>`; };
    }
  }

  function openMemory(memory) {
    trace("Glasses", `Opened “${memory.name}”`, { film: "264×264 silent H.264 from Cloudinary", sound: "the recording, played from the phone" });
    playFilm(memory, () => {
      hideLens();
    });
    state.opened++;
    card("opened", `<div class="card__kicker">Memories opened today · ${state.opened}</div><p style="margin-top:6px">Dad opened <b>${escape(memory.name)}</b> just now.</p>`, "card--done");
  }

  function ask(id) {
    stopAll();
    unaim();
    const q = QUESTIONS[id];
    showLens({ text: "Listening…", heard: `You: ${q.text}`, playing: "Listening", seconds: 1.2 });
    later(() => {
      const answer = state.answers[id];
      if (!answer) {
        trace("Gemini", "Which recorded answer fits?", { answer_id: "none" });
        state.asked[id]++;
        const say = "I don't have an answer for that yet. I'll let Sarah know you asked.";
        showLens({ text: say, heard: say, choices: [{ label: "Back", on: hideLens }] });
        later(hideLens, 6000);
        questionCard(id);
        trace("Server", "Sent to the family", { question: q.text, asked: state.asked[id] });
      } else {
        trace("Gemini", "Which recorded answer fits?", { answer_id: answer.id });
        const voice = answer.kind === "voice";
        showLens({ text: answer.text, sub: "Sarah", heard: voice ? answer.text : `Sarah wrote: ${answer.text}`, playing: voice ? "Sarah's recording" : "Read by a neutral voice", seconds: 6, choices: [{ label: "Back", on: hideLens }] });
        later(hideLens, 6400);
        state.asked[id]++;
        card(`replay:${id}`, `<div class="card__kicker">Dad asked again · your answer played</div><p class="card__q">${escape(q.text)}</p><p style="margin-top:6px;font-size:14px;color:var(--grey)">Asked ${state.asked[id]} times in all. You answered once.</p>`, "card--done");
      }
    }, 1300);
  }

  room.querySelectorAll("[data-thing]").forEach((el) => el.addEventListener("click", () => look(el.dataset.thing, el)));
  document.querySelectorAll("[data-ask]").forEach((el) => el.addEventListener("click", () => ask(el.dataset.ask)));
  document.getElementById("reset").addEventListener("click", reset);

  function reset() {
    stopAll();
    phoneTimers.forEach((t) => (clearTimeout(t), clearInterval(t)));
    phoneTimers = [];
    hideLens();
    unaim();
    if (state) Object.values(state.cards).forEach((el) => el.remove());
    state = fresh();
    tracelog.innerHTML = `<div class="trace__entry"><span class="who">Waiting for Jimmy to look at something or ask…</span></div>`;
    waiting();
  }
  reset();
})();
