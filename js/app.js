/* ==========================================================================
   BuildMind — app.js
   Shared frontend foundation: brand assets, ambient choreography, reveal
   observers, storage helpers and the mock BuildMind state layer.

   Phase 1 note: every "connected" or "building" state below is simulated in
   the browser. No network requests, no backend, no AI calls, no Roblox calls.
   The public functions (connectRoblox, connectStudio, startBuild, ...) are the
   seams where real integrations will be attached later.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  /* ------------------------------------------------------------------------
     Constants
     ------------------------------------------------------------------------ */
  const STORAGE_KEY = "buildmind.settings.v1";
  const PREFERENCES_KEY = "buildmind.preferences.v1";

  const DEFAULTS = {
    provider: "openai",
    model: "gpt-4.1",
    motion: "full",
    robuxHints: true,
    autoFix: true,
    density: "comfortable",
  };

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

  /** Read a JSON blob from localStorage without throwing in private modes. */
  function readStore(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
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
     Icons — a single 16px stroke family, kept consistent everywhere
     ------------------------------------------------------------------------ */
  const ICONS = {
    home: '<path d="M3 7.5 8 3.5l5 4V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3.5A.5.5 0 0 1 3 13V7.5Z"/>',
    build:
      '<path d="M8 2.5 13.5 5.5v5L8 13.5 2.5 10.5v-5L8 2.5Z"/><path d="M8 8v5.5M8 8l3.2-1.8M8 8 4.8 6.2"/>',
    projects:
      '<rect x="2.5" y="3.5" width="11" height="9" rx="1.6"/><path d="M5.5 7h2M5.5 9.3h4.5"/>',
    settings:
      '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.4M8 12.7v1.4M14.1 8h-1.4M3.3 8H1.9M12.3 3.7l-1 1M4.7 11.3l-1 1M12.3 12.3l-1-1M4.7 4.7l-1-1"/>',
    arrow: '<path d="M3.2 8h9.6M9 4.2 12.8 8 9 11.8"/>',
    arrowUpRight: '<path d="M4.6 11.4 11.4 4.6M5.6 4.6h5.8v5.8"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    check: '<path d="M3.2 8.4 6.4 11.6 12.8 4.8"/>',
    spark:
      '<path d="M8 1.9l1.5 4.1 4.1 1.5-4.1 1.5L8 13.1 6.5 9 2.4 7.5 6.5 6 8 1.9Z"/>',
    plug: '<path d="M5.6 2.5v3M10.4 2.5v3M3.6 5.5h8.8v1.6a4.4 4.4 0 0 1-8.8 0V5.5ZM8 11.5v2"/>',
    monitor: '<rect x="2" y="3" width="12" height="8" rx="1.4"/><path d="M5.6 13.4h4.8M8 11v2.4"/>',
    key: '<circle cx="5.4" cy="9.6" r="2.6"/><path d="M7.3 7.7 12.6 2.4M10.4 4.6l1.6 1.6"/>',
    eye: '<path d="M1.8 8S4.1 3.9 8 3.9 14.2 8 14.2 8s-2.3 4.1-6.2 4.1S1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.7"/>',
    eyeOff:
      '<path d="M6.3 4.2A6.6 6.6 0 0 1 8 3.9c3.9 0 6.2 4.1 6.2 4.1a11 11 0 0 1-2 2.4M9.8 11.6A6.7 6.7 0 0 1 8 12.1C4.1 12.1 1.8 8 1.8 8a11 11 0 0 1 2.6-2.9M2.6 2.6l10.8 10.8"/>',
    shield: '<path d="M8 2 13 4v4c0 3.1-2.1 5.4-5 6-2.9-.6-5-2.9-5-6V4l5-2Z"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2 1.2"/>',
    play: '<path d="M5.6 3.6 12 8l-6.4 4.4V3.6Z"/>',
    layers: '<path d="M8 2.4 13.6 5.4 8 8.4 2.4 5.4 8 2.4Z"/><path d="M2.4 8.2 8 11.2l5.6-3M2.4 11 8 14l5.6-3"/>',
    refresh: '<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8M13.4 2.6v2.8h-2.8"/>',
    info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.2v3.4M8 5.2v.6"/>',
    chevron: '<path d="M5.8 3.8 10 8l-4.2 4.2"/>',
    stop: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2"/>',
    warn: '<path d="M8 3 14 13H2L8 3Z"/><path d="M8 7v2.6M8 11.4v.4"/>',
  };

  /** Return an inline SVG string for a named icon. */
  function icon(name, cls = "") {
    const body = ICONS[name] || ICONS.info;
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"
      ${cls ? `class="${cls}"` : ""}>${body}</svg>`;
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
      // Anything already above the fold reveals immediately on the next frame
      // so the first paint is never empty.
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.9) {
        requestAnimationFrame(() => el.classList.add("is-revealed"));
      } else {
        revealObserver.observe(el);
      }
    });
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

    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      sheet.classList.toggle("is-open", open);
      sheet.toggleAttribute("inert", !open);
      document.body.style.overflow = open ? "hidden" : "";
    };

    setOpen(false);

    toggle.addEventListener("click", () => {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    // Close on navigation or Escape
    $$("a", sheet).forEach((link) => link.addEventListener("click", () => setOpen(false)));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        toggle.focus();
      }
    });

    // Reset when resizing up to desktop
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
     Preferences (appearance + motion)
     ------------------------------------------------------------------------ */
  function applyMotionPreference(mode) {
    const reduced = mode === "reduced" || (mode === "system" && prefersReducedMotion());
    document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  }

  function loadPreferences() {
    const prefs = readStore(PREFERENCES_KEY, { motion: DEFAULTS.motion });
    applyMotionPreference(prefs.motion || DEFAULTS.motion);
    return prefs;
  }

  function savePreferences(patch) {
    const next = { ...loadPreferences(), ...patch };
    writeStore(PREFERENCES_KEY, next);
    if (next.motion) applyMotionPreference(next.motion);
    return next;
  }

  /* ------------------------------------------------------------------------
     Settings store — Phase 1 uses localStorage only.
     ------------------------------------------------------------------------ */
  function loadSettings() {
    return readStore(STORAGE_KEY, { ...DEFAULTS });
  }

  function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    writeStore(STORAGE_KEY, next);
    return next;
  }

  /* ------------------------------------------------------------------------
     Connection state (simulated)
     ------------------------------------------------------------------------ */
  const connections = {
    roblox: { label: "Roblox", connected: false, kind: "account" },
    studio: { label: "Roblox Studio", connected: false, kind: "bridge" },
  };

  const listeners = new Set();

  function onStateChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emit(type, detail) {
    listeners.forEach((fn) => {
      try {
        fn(type, detail);
      } catch (err) {
        console.error("[BuildMind] listener failed", err);
      }
    });
  }

  /**
   * Simulated Roblox account connection.
   * Phase 2 will replace the body with the OAuth hand-off.
   */
  async function connectRoblox(force) {
    if (connections.roblox.connected && !force) return connections.roblox;
    connections.roblox.connected = true;
    connections.roblox.simulated = true;
    emit("connection", { target: "roblox", connected: true });
    return connections.roblox;
  }

  function disconnectRoblox() {
    connections.roblox.connected = false;
    emit("connection", { target: "roblox", connected: false });
  }

  /**
   * Simulated Studio bridge handshake.
   * Phase 2 will replace the body with the local bridge discovery.
   */
  async function connectStudio(force) {
    if (connections.studio.connected && !force) return connections.studio;
    await sleep(900);
    connections.studio.connected = true;
    connections.studio.simulated = true;
    emit("connection", { target: "studio", connected: true });
    return connections.studio;
  }

  function disconnectStudio() {
    connections.studio.connected = false;
    emit("connection", { target: "studio", connected: false });
  }

  function getConnections() {
    return connections;
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
     Build stages — shared vocabulary for the build page and projects
     ------------------------------------------------------------------------ */
  const BUILD_STAGES = [
    { id: "understand", label: "Understanding idea" },
    { id: "plan", label: "Planning" },
    { id: "build", label: "Building" },
    { id: "test", label: "Testing" },
    { id: "fix", label: "Fixing" },
    { id: "validate", label: "Validating" },
    { id: "complete", label: "Complete" },
  ];

  /* ------------------------------------------------------------------------
     Provider catalogue — UI data only, no keys, no endpoints
     ------------------------------------------------------------------------ */
  const PROVIDERS = [
    {
      id: "openai",
      label: "OpenAI",
      models: [
        { id: "gpt-4.1", label: "GPT-4.1" },
        { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
        { id: "o4-mini", label: "o4-mini" },
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      models: [
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ],
    },
    {
      id: "google",
      label: "Google",
      models: [
        { id: "gemini-2-5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2-5-flash", label: "Gemini 2.5 Flash" },
      ],
    },
    {
      id: "xai",
      label: "xAI",
      models: [{ id: "grok-4", label: "Grok 4" }],
    },
  ];

  function findProvider(id) {
    return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
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
          `<circle class="wv-node ${n.accent ? "wv-node--accent" : ""}" cx="${n.x}" cy="${
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
        <g class="worldviz__orbit">
          <ellipse class="wv-ring" cx="${WORLD.cx}" cy="${WORLD.cy - 14}" rx="164" ry="58"/>
        </g>
        <g class="worldviz__orbit worldviz__orbit--slow">
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
     Project thumbnails — generated abstract scenes, one language
     ------------------------------------------------------------------------ */
  const SCENE_VIEW = { w: 320, h: 180 };

  function sceneLattice() {
    const cells = [];
    const hw = 16;
    const hh = 8;
    const ox = 160;
    const oy = 92;
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        const x = ox + (i - j) * hw;
        const y = oy + (i + j - 4) * hh;
        const built = (i + j) % 3 !== 0;
        cells.push(
          `<polygon points="${x},${y - hh} ${x + hw},${y} ${x},${y + hh} ${x - hw},${y}"
            fill="${built ? "rgba(139,147,255,0.16)" : "rgba(255,255,255,0.03)"}"
            stroke="${built ? "rgba(139,147,255,0.34)" : "rgba(255,255,255,0.08)"}" stroke-width="1"/>`
        );
      }
    }
    return cells.join("");
  }

  function sceneArcs() {
    const arcs = [];
    for (let r = 30; r <= 118; r += 22) {
      arcs.push(
        `<path d="M ${160 - r} 132 A ${r} ${r} 0 0 1 ${160 + r} 132" fill="none"
          stroke="rgba(139,147,255,${0.1 + r / 1400})" stroke-width="1"/>`
      );
    }
    const dots = [
      [92, 74],
      [160, 46],
      [228, 74],
      [126, 116],
      [196, 112],
    ]
      .map(
        ([x, y], i) =>
          `<circle cx="${x}" cy="${y}" r="${i === 1 ? 3.6 : 2.4}" fill="${
            i === 1 ? "rgba(139,147,255,0.75)" : "rgba(255,255,255,0.28)"
          }"/>`
      )
      .join("");
    return arcs.join("") + dots;
  }

  function sceneTerrain() {
    let paths = "";
    for (let line = 0; line < 4; line += 1) {
      let d = `M 0 ${104 + line * 11}`;
      for (let x = 0; x <= 320; x += 32) {
        const y =
          104 + line * 11 + Math.sin((x / 320) * Math.PI * 2 + line * 0.7) * (9 - line * 1.5);
        d += ` L ${x} ${y.toFixed(1)}`;
      }
      paths += `<path d="${d}" fill="none" stroke="rgba(139,147,255,${
        0.26 - line * 0.05
      })" stroke-width="1"/>`;
    }
    const blocks = [
      [84, 88],
      [148, 74],
      [214, 92],
    ]
      .map(
        ([x, y]) =>
          `<rect x="${x}" y="${y}" width="20" height="20" rx="3" fill="rgba(255,255,255,0.05)"
            stroke="rgba(139,147,255,0.28)" stroke-width="1"/>`
      )
      .join("");
    return paths + blocks;
  }

  function sceneGraph() {
    const pts = [
      [58, 132],
      [104, 68],
      [160, 104],
      [210, 54],
      [262, 118],
      [160, 152],
    ];
    const edges = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [2, 5],
      [4, 5],
      [1, 3],
    ]
      .map(
        ([a, b]) =>
          `<line x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}"
            stroke="rgba(139,147,255,0.20)" stroke-width="1" stroke-dasharray="2 4"/>`
      )
      .join("");
    const dots = pts
      .map(
        ([x, y], i) =>
          `<circle cx="${x}" cy="${y}" r="${i === 2 ? 4 : 2.6}" fill="${
            i === 2 ? "rgba(139,147,255,0.8)" : "rgba(255,255,255,0.26)"
          }"/>`
      )
      .join("");
    return edges + dots;
  }

  function scenePlates() {
    let out = "";
    for (let layer = 3; layer >= 0; layer -= 1) {
      const y = 78 + layer * 20;
      const w = 96 + layer * 22;
      out += `<path d="M ${160 - w} ${y} L 160 ${y - w * 0.42} L ${160 + w} ${y}
        L 160 ${y + w * 0.42} Z" fill="rgba(139,147,255,${
          0.03 + layer * 0.015
        })" stroke="rgba(255,255,255,${0.05 + layer * 0.02})" stroke-width="1"/>`;
    }
    out += `<circle cx="160" cy="70" r="3.4" fill="rgba(95,224,191,0.7)"/>`;
    return out;
  }

  function sceneDots() {
    let out = "";
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const cx = 40 + x * 30;
        const cy = 52 + y * 19;
        const active = (x + y) % 4 === 1;
        out += `<circle cx="${cx}" cy="${cy}" r="${active ? 2.4 : 1.5}"
          fill="${active ? "rgba(139,147,255,0.7)" : "rgba(255,255,255,0.13)"}"/>`;
      }
    }
    out += `<path d="M 40 52 Q 100 24 160 90 T 280 128" fill="none"
      stroke="rgba(139,147,255,0.32)" stroke-width="1"/>`;
    return out;
  }

  const SCENES = [sceneLattice, sceneTerrain, sceneGraph, sceneArcs, scenePlates, sceneDots];

  /**
   * Render a generated thumbnail into a container.
   * @param {HTMLElement} el
   * @param {number} variant  index into the scene set
   */
  function renderScene(el, variant = 0) {
    if (!el) return;
    const scene = SCENES[variant % SCENES.length];
    el.innerHTML = `
      <svg viewBox="0 0 ${SCENE_VIEW.w} ${SCENE_VIEW.h}" preserveAspectRatio="xMidYMid slice"
           role="img" aria-label="Abstract project preview" focusable="false">
        <defs>
          <radialGradient id="scene-bg-${variant}" cx="50%" cy="30%" r="70%">
            <stop offset="0%" stop-color="#15151d"/>
            <stop offset="100%" stop-color="#0c0c11"/>
          </radialGradient>
        </defs>
        <rect width="${SCENE_VIEW.w}" height="${SCENE_VIEW.h}" fill="url(#scene-bg-${
      variant % SCENES.length
    })"/>
        ${scene()}
      </svg>`;
    el.dataset.scene = String(variant % SCENES.length);
  }

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */
  function boot() {
    document.documentElement.classList.add("js");
    loadPreferences();
    initAmbient();
    initHeader();
    initPageTransitions();
    initReveals();

    // Fill in shared brand marks and mark the active nav item defensively.
    $$("[data-brand-mark]").forEach((el) => {
      el.innerHTML = el.dataset.brandMark === "sm" ? BRAND_MARK_SM : BRAND_MARK;
    });

    // Mount any visualizer that is present before page scripts run.
    $$("[data-world]").forEach((el) => mountWorld(el));

    // Re-run reveals for any content injected after boot.
    BM.refreshReveals = initReveals;
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
    prefersReducedMotion,
    toast,
    readStore,
    writeStore,
    loadSettings,
    saveSettings,
    loadPreferences,
    savePreferences,
    applyMotionPreference,
    media,
    connectRoblox,
    disconnectRoblox,
    connectStudio,
    disconnectStudio,
    getConnections,
    onStateChange,
    BUILD_STAGES,
    PROVIDERS,
    findProvider,
    mountWorld,
    updateWorld,
    startWorldPreview,
    renderScene,
    keys: { STORAGE_KEY, PREFERENCES_KEY },
    defaults: DEFAULTS,
  });
})();
