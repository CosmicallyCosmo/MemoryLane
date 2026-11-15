// Shared behaviour for every page: the menu, the bar's edge, reveal on scroll, numbers that
// count up, the hero's lens, copy buttons and the contents rail.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const toggle = document.querySelector(".nav-toggle");
  const nav = document.getElementById("nav");
  toggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav?.addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      nav.classList.remove("is-open");
      toggle?.setAttribute("aria-expanded", "false");
    }
  });

  const bar = document.querySelector(".topbar");
  const onScroll = () => bar?.classList.toggle("is-scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  function countUp(el) {
    const to = Number(el.dataset.count);
    if (reduced || !to) return;
    const start = performance.now();
    const ms = 1400;
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        entry.target.querySelectorAll("[data-count]").forEach(countUp);
        if (entry.target.matches("[data-count]")) countUp(entry.target);
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  document.querySelectorAll(".reveal, .results, .dash").forEach((el) => seen.observe(el));

  // A thin line under the bar shows how far down the page you are.
  if (bar) {
    const line = document.createElement("div");
    line.className = "progressline";
    bar.append(line);
    const draw = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      line.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    };
    addEventListener("scroll", draw, { passive: true });
    draw();
  }

  // The hero's glasses lean towards the pointer.
  const specs = document.querySelector(".specs__frame");
  if (specs && !reduced && matchMedia("(pointer: fine)").matches) {
    const hero = specs.closest(".hero");
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      specs.style.translate = `${x * 14}px ${y * 10}px`;
      specs.style.rotate = `y ${x * 14}deg`;
    });
    hero.addEventListener("pointerleave", () => {
      specs.style.translate = "";
      specs.style.rotate = "";
    });
  }

  // The hero's lens shows what the display would, one moment after another.
  const hud = document.querySelectorAll("#hud .hud-msg");
  if (hud.length && !reduced) {
    let i = 0;
    setInterval(() => {
      hud[i].classList.remove("is-on");
      i = (i + 1) % hud.length;
      hud[i].classList.add("is-on");
    }, 3600);
  }

  document.querySelectorAll("pre.code[data-copy]").forEach((pre) => {
    const text = pre.dataset.copy || pre.textContent.trim();
    const button = document.createElement("button");
    button.className = "copy";
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => (button.textContent = "Copy"), 1600);
    });
    pre.append(button);
  });

  // The contents rail follows the section in view.
  const toc = document.querySelectorAll(".toc a");
  if (toc.length) {
    const byId = new Map([...toc].map((a) => [a.hash.slice(1), a]));
    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          toc.forEach((a) => a.classList.remove("is-on"));
          byId.get(entry.target.id)?.classList.add("is-on");
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    byId.forEach((_, id) => {
      const section = document.getElementById(id);
      if (section) spy.observe(section);
    });
  }
})();
