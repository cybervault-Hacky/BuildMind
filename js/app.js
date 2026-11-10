/* ==========================================================================
   BuildMind — app.js
   The application shell and boot sequence: brand marks, ambient choreography,
   reveals, page transitions, toasts, the world visualizer and the helper
   functions every page shares.

   State itself lives in js/state.js, integrations in js/services/ and the
   orchestration between them in js/controllers/. This file only boots:
     1. apply the motion preference (before paint)
     2. initialise the service layer
     3. load state through the controllers
     4. start cross-tab sync

   Every "connected" or "building" state is simulated in the browser. There are
   no network requests, no backend, no AI calls and no Roblox calls.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  /* ------------------------------------------------------------------------
     Constants
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** matchMedia with a graceful fallback for non-browser environments. */
  function media(query) {
    if (typeof window.matchMedia !== "function") {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    }
    return window.matchMedia(query);
  }

  function prefersReducedMotion() {
    return media("(prefers-reduced-motion: reduce)").matches;
  }

  /* ------------------------------------------------------------------------
     Brand assets (original BuildMind marks — no third-party artwork)
     ------------------------------------------------------------------------ */
  const BRAND_MARK = `
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="bm-mark-g" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#a8aeff"/>
          <stop offset="1" stop-color="#737cf2"/>
        </linearGradient>
      </defs>
      <path d="M16 3.2 27.4 9.6v12.8L16 28.8 4.6 22.4V9.6L16 3.2Z" stroke="url(#bm-mark-g)" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M16 10.1 22 13.5v7L16 23.9l-6-3.4v-7L16 10.1Z" fill="url(#bm-mark-g)" fill-opacity="0.34" stroke="url(#bm-mark-g)" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M16 17v6.9M16 17l6-3.5M16 17l-6-3.5" stroke="url(#bm-mark-g)" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;

  const BRAND_MARK_SM = BRAND_MARK.replace(/id="bm-mark-g"/g, 'id="bm-mark-g-sm"').replace(
    /url\(#bm-mark-g\)/g,
    "url(#bm-mark-g-sm)"
  );

  /* ------------------------------------------------------------------------
     Icons — the two glyphs the UI swaps in at runtime. Everything else is
     inline in the markup, so nothing unused ships.
     ------------------------------------------------------------------------ */
  const ICONS = {
    check: '<path d="M3.2 8.4 6.4 11.6 12.8 4.8"/>',
    stop: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2"/>',
  };

  /** Return an inline SVG string for a named runtime icon. */
  function icon(name) {
    const body = ICONS[name] || ICONS.check;
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  /* ------------------------------------------------------------------------
     Motion preference — the shell applies it to <html data-motion>
     ------------------------------------------------------------------------ */
  function applyMotionPreference(mode) {
    const reduced = mode === "reduced";
    document.documentElement.dataset.motionMode = reduced ? "reduced" : "full";
  }

  /* ------------------------------------------------------------------------
     Ambient background: cursor light + pointer capability flag
     ------------------------------------------------------------------------ */
  function initAmbient() {
    const cursor = $(".ambient__cursor");
    const fine = media("(hover: hover) and (pointer: fine)").matches;

    if (!fine) return;

    document.documentElement.classList.add("has-pointer");

    let raf = 0;
    let tx = window.innerWidth / 2;
    let ty = window.innerHeight * 0.25;
    let cx = tx;
    let cy = ty;

    const render = () => {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      if (cursor) {
        cursor.style.setProperty("--mx", `${cx.toFixed(1)}px`);
        cursor.style.setProperty("--my", `${cy.toFixed(1)}px`);
      }
      const settled = Math.abs(tx - cx) < 0.4 && Math.abs(ty - cy) < 0.4;
      raf = settled ? 0 : requestAnimationFrame(render);
    };

    window.addEventListener(
      "pointermove",
      (event) => {
        if (prefersReducedMotion()) return;
        tx = event.clientX;
        ty = event.clientY;
        if (!raf) raf = requestAnimationFrame(render);
      },
      { passive: true }
    );
  }

  /* ------------------------------------------------------------------------
     Scroll reveals
     ------------------------------------------------------------------------ */
  let revealObserver = null;

  function initReveals() {
    const targets = $$("[data-reveal], [data-stagger]");
    if (!targets.length) return;

    const reduce = prefersReducedMotion();

    targets.forEach((el) => {
      const delay = el.dataset.revealDelay;
      if (delay) el.style.setProperty("--reveal-delay", `${delay}ms`);
    });

    if (reduce || !("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("is-revealed"));
      return;
    }

    if (!revealObserver) {
      revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-revealed");
            revealObserver.unobserve(entry.target);
          });
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
      );
    }

    targets.forEach((el) => {
      // Anything already above the fold reveals immediately, so the first paint
      // is never empty. Everything else waits for the observer.
      //
      // The fold is measured generously (full viewport + a margin) because the
      // observer's own rootMargin is negative: an element between 90% and 100%
      // of the viewport used to be handed to an observer that could not fire
      // for it yet, leaving a visible block at opacity 0 on tall pages.
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight + 120) {
        requestAnimationFrame(() => el.classList.add("is-revealed"));
      } else {
        revealObserver.observe(el);
      }
    });

    // Safety net: a reveal that can never fire (layout settled off-screen after
    // the observer was created, or a scroll container the observer cannot see)
    // must not hide content forever. One late pass, not a loop.
    window.setTimeout(() => {
      $$("[data-reveal]:not(.is-revealed), [data-stagger]:not(.is-revealed)").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 1.5) el.classList.add("is-revealed");
      });
    }, 1200);
  }

  /* ------------------------------------------------------------------------
     Header: stuck state, mobile sheet, page focus
     ------------------------------------------------------------------------ */
  function initHeader() {
    const header = $(".site-header");
    if (!header) return;

    let ticking = false;
    const sync = () => {
      header.classList.toggle("is-stuck", window.scrollY > 6);
      ticking = false;
    };

    sync();
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(sync);
      },
      { passive: true }
    );

    const toggle = $(".menu-toggle");
    const sheet = $("#mobile-nav");
    if (!toggle || !sheet) return;

    // `inert` keeps the sheet out of the tab order when it is closed.
    const supportInert = "inert" in HTMLElement.prototype;

    const setOpen = (open, { restoreFocus = false } = {}) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      sheet.classList.toggle("is-open", open);
      if (supportInert) sheet.inert = !open;
      else sheet.setAttribute("aria-hidden", String(!open));
      document.body.classList.toggle("is-sheet-open", open);
      // The scrim lives on .page: .page is its own stacking context, so a
      // body-level overlay would paint underneath the sheet.
      $(".page")?.classList.toggle("is-sheet-open", open);
      if (!open) {
        BM.updateActiveNav?.();
        if (restoreFocus) toggle.focus({ preventScroll: true });
      }
    };

    setOpen(false);

    toggle.addEventListener("click", () => {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    // Closing on navigation must not cancel the click's own navigation.
    $$("a", sheet).forEach((link) =>
      link.addEventListener("click", () => setOpen(false))
    );

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false, { restoreFocus: true });
      }
    });

    // Keep focus inside the sheet while it is open.
    sheet.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusables = $$(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        sheet
      ).filter((node) => node.offsetParent !== null);
      if (!focusables.length) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === toggle)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        toggle.focus();
      }
    });

    const desktop = media("(min-width: 861px)");
    if (typeof desktop.addEventListener === "function") {
      desktop.addEventListener("change", (event) => {
        if (event.matches) setOpen(false);
      });
    }
  }

  /* ------------------------------------------------------------------------
     Page transitions
     Visual only: navigation still uses real page loads, so links keep working
     with JavaScript disabled.
     ------------------------------------------------------------------------ */
  function initPageTransitions() {
    const veil = document.createElement("div");
    veil.className = "page-veil";
    veil.setAttribute("aria-hidden", "true");
    document.body.appendChild(veil);

    document.body.classList.add("is-entering");
    window.addEventListener("load", () => document.body.classList.remove("is-entering"));

    if (prefersReducedMotion()) return;

    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.target && link.target !== "_self") return;
      if (link.hasAttribute("download")) return;

      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;

      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      event.preventDefault();
      document.body.classList.add("is-leaving");
      veil.classList.add("is-active");

      // Leave enough time for the fade, but never trap the user.
      window.setTimeout(() => {
        window.location.href = url.href;
      }, 190);
    });

    // Restore visuals when the page comes back from the bfcache.
    window.addEventListener("pageshow", () => {
      document.body.classList.remove("is-leaving");
      veil.classList.remove("is-active");
    });
  }

  /* ------------------------------------------------------------------------
     Password reveal — shared by the composer and settings
     ------------------------------------------------------------------------ */
  function bindKeyReveal(input, button) {
    if (!input || !button) return;

    const eye = button.querySelectorAll(".icon-eye");
    const eyeOff = button.querySelector(".icon-eye-off");

    button.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-pressed", String(reveal));
      button.setAttribute("aria-label", reveal ? "Hide API key" : "Show API key");
      // Open eye while masked, struck-through eye while the key is visible.
      eye.forEach((node) => node.toggleAttribute("hidden", reveal));
      if (eyeOff) eyeOff.classList.toggle("is-off", !reveal);
      input.focus({ preventScroll: true });
    });
  }

  /* ------------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------------ */
  let toastEl = null;
  let toastTimer = 0;

  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = `${icon("check")}<span></span>`;
    toastEl.querySelector("span").textContent = message;
    toastEl.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("is-visible"), 2200);
  }

  /* ------------------------------------------------------------------------
     Visual system — original, generated, abstract.
     No third-party artwork: everything is projection math and CSS.
     ------------------------------------------------------------------------ */
  const WORLD = {
    view: 400,
    cols: 6,
    rows: 6,
    hw: 27,
    hh: 13.5,
    cx: 200,
    cy: 202,
  };

  function projectCell(i, j) {
    const { cols, rows, hw, hh, cx, cy } = WORLD;
    const x = cx + (i - j) * hw;
    const y = cy + (i + j - (rows + cols - 2) / 2) * hh;
    return { x, y };
  }

  function diamond(x, y, hw = WORLD.hw, hh = WORLD.hh) {
    return `${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}`;
  }

  /** Build the DOM for the world-construction visualizer (once). */
  function mountWorld(el) {
    if (!el || el.dataset.mounted === "true") return el;
    el.dataset.mounted = "true";
    el.dataset.state = el.dataset.state || "idle";

    const cells = [];
    for (let i = 0; i < WORLD.rows; i += 1) {
      for (let j = 0; j < WORLD.cols; j += 1) {
        const { x, y } = projectCell(i, j);
        cells.push({ i, j, x, y, depth: i + j });
      }
    }
    cells.sort((a, b) => a.depth - b.depth || a.x - b.x);

    const cellMarkup = cells
      .map(
        (c, index) =>
          `<polygon class="wv-cell" data-cell="${index}" points="${diamond(c.x, c.y)}" />`
      )
      .join("");

    const nodes = [
      { x: 200, y: 74, r: 6.5, accent: true },
      { x: 132, y: 106, r: 4.5 },
      { x: 272, y: 100, r: 4.5 },
      { x: 232, y: 56, r: 3 },
      { x: 158, y: 62, r: 3 },
    ];

    const edges = [
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [1, 4],
      [2, 3],
    ];

    const nodeMarkup = edges
      .map(
        ([a, b]) =>
          `<line class="wv-edge wv-edge--flow" x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${
            nodes[b].x
          }" y2="${nodes[b].y}" style="animation-delay:${(a + b) * 220}ms" />`
      )
      .join("");

    const dotMarkup = nodes
      .map(
        (n, index) =>
          `<circle class="${n.accent ? "wv-node wv-node--accent" : "wv-node"}" cx="${n.x}" cy="${
            n.y
          }" r="${n.r}" style="animation-delay:${index * 140}ms" />`
      )
      .join("");

    el.innerHTML = `
      <svg viewBox="0 0 ${WORLD.view} ${WORLD.view}" role="img"
           aria-label="Abstract visualisation of a game world being assembled">
        <defs>
          <radialGradient id="wv-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#8b93ff" stop-opacity="0.20"/>
            <stop offset="100%" stop-color="#8b93ff" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="wv-scan-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#8b93ff" stop-opacity="0"/>
            <stop offset="60%" stop-color="#8b93ff" stop-opacity="0.10"/>
            <stop offset="100%" stop-color="#8b93ff" stop-opacity="0"/>
          </linearGradient>
        </defs>

        <circle cx="${WORLD.cx}" cy="${WORLD.cy - 6}" r="150" fill="url(#wv-glow)"/>

        <!-- orbital rings -->
        <g class="worldviz__orbit" style="transform-origin: ${WORLD.cx}px ${WORLD.cy - 14}px">
          <ellipse class="wv-ring" cx="${WORLD.cx}" cy="${WORLD.cy - 14}" rx="164" ry="58"/>
        </g>
        <g class="worldviz__orbit worldviz__orbit--slow" style="transform-origin: ${WORLD.cx}px ${WORLD.cy - 14}px">
          <ellipse class="wv-ring" cx="${WORLD.cx}" cy="${WORLD.cy - 14}" rx="128" ry="44"/>
        </g>

        <!-- ground axes -->
        <line class="wv-axis" x1="${WORLD.cx - 172}" y1="${WORLD.cy}" x2="${WORLD.cx + 172}" y2="${
      WORLD.cy
    }"/>
        <line class="wv-axis" x1="${WORLD.cx}" y1="${
      WORLD.cy - 118
    }" x2="${WORLD.cx}" y2="${WORLD.cy + 118}"/>

        <!-- the world lattice -->
        <g class="worldviz__float">${cellMarkup}</g>

        <!-- moving construction scan -->
        <g class="worldviz__scan">
          <rect x="${WORLD.cx - 190}" y="${WORLD.cy - 96}" width="380" height="64"
                fill="url(#wv-scan-grad)"/>
        </g>

        <!-- planning graph -->
        <g>${nodeMarkup}${dotMarkup}</g>
      </svg>`;
    return el;
  }

  /**
   * Drive the visualizer.
   * @param {HTMLElement} el
   * @param {{state?: string, progress?: number}} options
   */
  function updateWorld(el, options = {}) {
    if (!el) return;
    if (el.dataset.mounted !== "true") mountWorld(el);

    const state = options.state || "idle";
    const progress = clamp(Number(options.progress) || 0, 0, 100);
    el.dataset.state = state;

    const cells = el.querySelectorAll(".wv-cell");
    const total = cells.length;

    // When the run stops, drop the scan band so it does not sit on screen
    const scan = el.querySelector(".worldviz__scan");
    if (scan) scan.style.display = state === "idle" || state === "complete" ? "none" : "";

    // idle shows a light preview ring of cells, never a "built" claim
    if (state === "idle") {
      cells.forEach((cell, index) => {
        cell.classList.remove("is-built", "is-fixed");
        cell.style.opacity = index % 3 === 0 ? "0.5" : "0.28";
      });
      return;
    }

    const built = Math.round((progress / 100) * total);
    const fixedFrom = state === "fixing" || state === "complete" ? Math.round(total * 0.32) : -1;

    cells.forEach((cell, index) => {
      cell.style.opacity = "";
      cell.classList.toggle("is-built", index < built);
      cell.classList.toggle(
        "is-fixed",
        fixedFrom > -1 && index >= fixedFrom && index < Math.min(total, fixedFrom + Math.round(total * 0.26))
      );
    });
  }

  /** Gentle preview loop for the home hero. */
  function startWorldPreview(el, speed = 1) {
    if (!el) return () => {};
    mountWorld(el);

    if (prefersReducedMotion()) {
      updateWorld(el, { state: "complete", progress: 100 });
      return () => {};
    }

    let progress = 0;
    let direction = 1;
    let timer = 0;
    let halted = false;

    const tick = () => {
      if (halted) return;
      if (document.hidden) {
        timer = window.setTimeout(tick, 400);
        return;
      }
      progress += direction * (0.9 * speed);
      if (progress >= 100) {
        progress = 100;
        direction = -1;
        window.setTimeout(tick, 1400);
        updateWorld(el, { state: "complete", progress: 100 });
        return;
      }
      if (progress <= 0) {
        progress = 0;
        direction = 1;
      }
      updateWorld(el, {
        state: progress > 0 ? (progress > 88 ? "validating" : "building") : "idle",
        progress,
      });
      timer = window.setTimeout(tick, 90);
    };

    updateWorld(el, { state: "idle", progress: 0 });
    timer = window.setTimeout(tick, 700);

    return () => {
      halted = true;
      window.clearTimeout(timer);
    };
  }

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */
  /**
   * Initialise every service boundary once, then load state through the
   * controllers. Order matters: state must exist before controllers load,
   * and services must be initialised before a controller talks to them.
   */
  function initServices() {
    BM.getState(); // touches state before any service does

    const ai = BM.aiService;
    ai?.initialize().then((result) => {
      const mode = BM.isOk(result) && result.data ? result.data.mode : "unknown";
      BM.setServiceMode(mode, BM.isOk(result));
    });

    // Project and settings controllers own the persisted slices.
    BM.settingsController?.load();
    BM.projectController?.load();
  }

  function boot() {
    document.documentElement.classList.add("js");

    // Motion is the one preference the shell needs before paint. Reading it is
    // the storage adapter's job, not the shell's.
    applyMotionPreference("full");

    initAmbient();
    initHeader();
    initPageTransitions();
    initReveals();

    // Load the shared state once for every page; page scripts only render it.
    BM.loadState?.();
    BM.initServices();
    BM.initSync?.();

    // Fill in shared brand marks and mark the active nav item defensively.
    $$("[data-brand-mark]").forEach((el) => {
      el.innerHTML = el.dataset.brandMark === "sm" ? BRAND_MARK_SM : BRAND_MARK;
    });

    // Mount any visualizer that is present before page scripts run.
    $$("[data-world]").forEach((el) => mountWorld(el));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ------------------------------------------------------------------------
     Public API — the future integration surface
     ------------------------------------------------------------------------ */
  Object.assign(BM, {
    $,
    $$,
    clamp,
    sleep,
    icon,
    bindKeyReveal,
    prefersReducedMotion,
    applyMotionPreference,
    media,
    toast,
    mountWorld,
    updateWorld,
    startWorldPreview,
    initServices,
  });
})();
