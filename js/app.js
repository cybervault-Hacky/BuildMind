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

   Nothing here decides product state: authentication, projects and builds are
   owned by the controllers and services in js/services → js/controllers. This
   file only paints the shell around them (brand, ambient light, reveals, page
   transitions, toasts, dialogs) and boots the service layer once.
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
          <stop offset="0" stop-color="#9db2ff"/>
          <stop offset="1" stop-color="#5d78ee"/>
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
    error: '<path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6"/>',
    info: '<path d="M8 4.2v.2M8 7.2v4.6"/>',
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

    // The cursor light is a desktop affordance. Coarse pointers, reduced motion
    // and a missing mount point all opt out before any listener is attached.
    if (!fine || !cursor || prefersReducedMotion()) return;

    document.documentElement.classList.add("has-pointer");

    let raf = 0;
    let lastX = window.innerWidth / 2;
    let lastY = window.innerHeight * 0.25;
    let cx = lastX;
    let cy = lastY;

    const render = () => {
      cx += (lastX - cx) * 0.09;
      cy += (lastY - cy) * 0.09;
      cursor.style.setProperty("--mx", `${cx.toFixed(1)}px`);
      cursor.style.setProperty("--my", `${cy.toFixed(1)}px`);
      const settled = Math.abs(lastX - cx) < 0.4 && Math.abs(lastY - cy) < 0.4;
      // One loop per settle: it stops when the light catches up, so an idle
      // pointer costs nothing at all.
      raf = settled ? 0 : requestAnimationFrame(render);
    };

    const onMove = (event) => {
      if (document.documentElement.getAttribute("data-motion-mode") === "reduced") return;
      lastX = event.clientX;
      lastY = event.clientY;
      if (!raf && !document.hidden) raf = requestAnimationFrame(render);
    };

    // A hidden tab must not keep a frame loop alive; resuming re-arms on the
    // next pointer move rather than spinning.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(
      "pagehide",
      () => {
        cancelAnimationFrame(raf);
        raf = 0;
        window.removeEventListener("pointermove", onMove);
        document.removeEventListener("visibilitychange", onVisibility);
      },
      { once: true }
    );
  }

  /* ------------------------------------------------------------------------
     Scroll reveals
     ------------------------------------------------------------------------ */
  let revealObserver = null;
  let revealScanTimer = 0;

  /**
   * Register every not-yet-revealed element with the one observer.
   * Idempotent: an element already observed or revealed is skipped, so the
   * post-boot rescan is cheap and can never stack observers.
   */
  function scanReveals() {
    if (!revealObserver) return;
    $$("[data-reveal]:not(.is-revealed), [data-stagger]:not(.is-revealed)").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight + 120 && rect.bottom > -120) {
        // Already in (or just above) the viewport: reveal on the next frame so
        // the transition runs, rather than waiting for a scroll that may never
        // come.
        requestAnimationFrame(() => el.classList.add("is-revealed"));
      } else {
        revealObserver.observe(el);
      }
    });
  }

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

    // Page scripts mount their content after boot (project cards, timeline
    // rows, the result panel). One rescan after they have run registers them,
    // and the same pass is the safety net for a reveal the observer can never
    // fire for. One timer, not a loop.
    window.clearTimeout(revealScanTimer);
    revealScanTimer = window.setTimeout(() => {
      $$("[data-reveal]:not(.is-revealed), [data-stagger]:not(.is-revealed)").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 1.5) el.classList.add("is-revealed");
        else revealObserver?.observe(el);
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
  /** True when either the OS or the in-app preference asks for less motion. */
  function motionReduced() {
    return (
      prefersReducedMotion() ||
      document.documentElement.getAttribute("data-motion-mode") === "reduced"
    );
  }

  function initPageTransitions() {
    const veil = document.createElement("div");
    veil.className = "page-veil";
    veil.setAttribute("aria-hidden", "true");
    document.body.appendChild(veil);

    document.body.classList.add("is-entering");
    const settle = () => document.body.classList.remove("is-entering");
    window.addEventListener("load", settle);
    // A page restored from bfcache, or one that finished loading before this
    // listener attached, would otherwise keep the entrance class forever.
    window.setTimeout(settle, 900);

    if (motionReduced()) return;

    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.target && link.target !== "_self") return;
      if (link.hasAttribute("download")) return;

      if (motionReduced()) return;

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
      }, 180);
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
     Dialog choreography

     Native <dialog> shows and hides instantly. The shell adds one class for
     the closing transition and calls the dialog's own close() when it ends, so
     Escape, backdrop clicks and the two owner scripts all share one exit.

     Reduced motion skips the wait entirely: the state change is what matters.
     ------------------------------------------------------------------------ */
  function closeDialog(dialog, onClosed) {
    if (!dialog) {
      if (typeof onClosed === "function") onClosed();
      return;
    }

    const finish = () => {
      dialog.classList.remove("is-closing");
      dialog.removeEventListener("animationend", onEnd);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (typeof onClosed === "function") onClosed();
    };

    if (prefersReducedMotion() || !dialog.open) {
      finish();
      return;
    }

    const onEnd = (event) => {
      if (event.target !== dialog) return;
      finish();
    };

    dialog.classList.add("is-closing");
    dialog.addEventListener("animationend", onEnd);
    // A closing dialog must never be stuck open if the animation is skipped by
    // the environment (throttled tab, display change). One timer, cleared by the
    // animation path because `finish` is idempotent through the listener guard.
    window.setTimeout(() => {
      if (dialog.classList.contains("is-closing")) finish();
    }, 260);
  }

  /* ------------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------------ */
  let toastEl = null;
  let toastText = null;
  let toastTimer = 0;

  /** Last painted visual state per mount point, so repeat ticks are free. */
  const localWorld = { state: "", progress: -1, scanHidden: null };

  /**
   * One polite live region for the whole product.
   *
   * @param {string} message human sentence, already normalised by the caller
   * @param {"success" | "error" | "info"} tone severity; carried by the icon
   *        and by data-tone (never by colour alone)
   */
  function toast(message, tone) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      toastEl.setAttribute("aria-atomic", "true");
      toastEl.innerHTML = `<span class="toast__icon" aria-hidden="true"></span><span class="toast__text"></span>`;
      toastText = toastEl.querySelector(".toast__text");
      document.body.appendChild(toastEl);
    }

    const severity = tone === "error" ? "error" : tone === "info" ? "info" : "success";
    const glyph = toastEl.querySelector(".toast__icon");
    if (glyph) glyph.innerHTML = icon(severity === "error" ? "error" : severity === "info" ? "info" : "check");
    toastEl.dataset.tone = severity;
    if (toastText && toastText.textContent !== message) toastText.textContent = message;

    // Re-trigger the entrance when a second message arrives during the first.
    toastEl.classList.remove("is-visible");
    void toastEl.offsetWidth;
    toastEl.classList.add("is-visible");

    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("is-visible"), 2600);
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
            <stop offset="0%" stop-color="#6d8bff" stop-opacity="0.20"/>
            <stop offset="100%" stop-color="#6d8bff" stop-opacity="0"/>
          </radialGradient>
          <linearGradient id="wv-scan-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6d8bff" stop-opacity="0"/>
            <stop offset="60%" stop-color="#6d8bff" stop-opacity="0.10"/>
            <stop offset="100%" stop-color="#6d8bff" stop-opacity="0"/>
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

    // The preview loop calls this ~11x a second. Writing an attribute that has
    // not changed still queues a mutation record and a style recalc, so the
    // tick becomes a no-op when nothing about the visual state actually moved.
    // (Measured before this guard: 33 redundant data-state writes per 3s.)
    const scan = el.querySelector(".worldviz__scan");
    const scanHidden = state === "idle" || state === "complete";

    if (el.dataset.state === state && localWorld.scanHidden === scanHidden &&
        localWorld.progress === progress && localWorld.state === state) {
      return;
    }

    if (el.dataset.state !== state) el.dataset.state = state;
    if (localWorld.scanHidden !== scanHidden) {
      // When the run stops, drop the scan band so it does not sit on screen.
      if (scan) scan.style.display = scanHidden ? "none" : "";
      localWorld.scanHidden = scanHidden;
    }
    localWorld.state = state;
    localWorld.progress = progress;

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
    const fixedTo = fixedFrom > -1 ? Math.min(total, fixedFrom + Math.round(total * 0.26)) : -1;

    cells.forEach((cell, index) => {
      if (cell.style.opacity) cell.style.opacity = "";
      const isBuilt = index < built;
      const isFixed = fixedFrom > -1 && index >= fixedFrom && index < fixedTo;
      // toggle() is a write even when the class already matches, so compare
      // first: the visible state only changes when a cell crosses a boundary.
      if (cell.classList.contains("is-built") !== isBuilt) cell.classList.toggle("is-built", isBuilt);
      if (cell.classList.contains("is-fixed") !== isFixed) cell.classList.toggle("is-fixed", isFixed);
    });
  }

  /* ------------------------------------------------------------------------
     Authentication gate

     A page that needs a session shows one of two messages: "sign in" when
     the session check answered "not signed in", and "the service is
     unavailable" when the check itself failed. The copy lives in the markup
     (data-gate-*), so each page says what is true for it.
     ------------------------------------------------------------------------ */
  function paintAuthGate() {
    const gate = $("[data-auth-gate]");
    if (!gate) return;

    const status = BM.getState().auth.status;
    const error = status === "error";

    const title = $(".empty__title", gate);
    const note = $(".empty__note", gate);

    const titleText = error ? gate.dataset.gateErrorTitle : gate.dataset.gateTitle;
    const noteText = error ? gate.dataset.gateErrorNote : gate.dataset.gateNote;

    if (title && titleText && title.textContent !== titleText) title.textContent = titleText;
    if (note && noteText && note.textContent !== noteText) note.textContent = noteText;

    // The sign-in call to action only makes sense when there is a session to
    // have; an unreachable service is not fixed by signing in.
    const action = $(".empty__action", gate);
    if (action) action.hidden = error;
  }

  /* ------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------ */
  /**
   * Initialise every service boundary once, then load state through the
   * controllers. Order matters: state must exist before controllers load,
   * services must be initialised before a controller talks to them, and the
   * session must be known before anything that depends on a session is
   * requested.
   */
  function initServices() {
    BM.getState(); // touches state before any service does

    // Pick the implementation explicitly before anything asks for one. The
    // remote backend is the default; the simulated mode is an explicit,
    // labelled deployment choice and is never entered as a fallback.
    if (typeof BM.installServices === "function") {
      BM.installServices(BM.requestedServiceMode());
    }

    // The session check comes first: the projects, the provider catalogue and
    // the account all depend on who is signed in.
    BM.authController?.init();

    const boot = BM.authController
      ? BM.authController.bootstrap()
      : Promise.resolve(BM.serviceOk(null));

    return boot.then((session) => {
      paintAuthGate();

      if (!BM.isOk(session)) {
        // The service could not be reached. That is an error state, and the
        // page says so. It is never downgraded to a simulation.
        BM.setServiceMode(BM.serviceMode || "remote", false);
        return session;
      }

      const ai = BM.aiService;
      const ready = (ai ? ai.initialize() : Promise.resolve(BM.serviceOk(null))).then((result) => {
        const mode = BM.isOk(result) && result.data ? result.data.mode : "unknown";
        BM.setServiceMode(mode, BM.isOk(result));
        BM.settingsController?.load({ skipProviders: BM.isOk(result) && result.data && result.data.ready });
        return result;
      });

      if (BM.isAuthenticated()) {
        BM.connectionController?.restore?.();
        BM.projectController?.load();
      }

      return ready;
    });
  }

  // The shell boots once per document. Guards against a re-dispatched
  // DOMContentLoaded re-running the header/reveal/transition wiring.
  let booted = false;

  function boot() {
    if (booted) return;
    booted = true;

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
    BM.subscribe?.((view, changed) => {
      if (!changed.length || changed.includes("auth")) paintAuthGate();
    });
    BM.initServices();
    BM.initSync?.();

    // A page that is torn down mid-build must not leave a live stream behind.
    window.addEventListener(
      "pagehide",
      () => {
        BM.sse?.closeAll?.("pagehide");
      },
      { once: true }
    );

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
    closeDialog,
    prefersReducedMotion,
    applyMotionPreference,
    media,
    toast,
    mountWorld,
    updateWorld,
    initServices,
    paintAuthGate,
    scanReveals,
  });
})();
