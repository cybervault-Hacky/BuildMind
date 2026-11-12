/* ==========================================================================
   BuildMind — home.js
   Home page behaviour: the construction field's assembly and pointer response,
   and the hero's real Roblox connection boundary.

   Everything here is decoration or a delegate call. The field is complete
   without JavaScript; this file only decides when its entrance starts and
   whether it tracks the pointer. Nothing on this page talks to a service
   directly — the Roblox chip reads the store and calls
   `connectionController`, exactly like Build and Settings do.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { $, prefersReducedMotion } = BM;

  /** The stored preference, applied live by Settings on any page. */
  function motionIsReduced() {
    return document.documentElement.getAttribute("data-motion-mode") === "reduced";
  }

  /* ------------------------------------------------------------------------
     Construction field — entrance

     Two classes, in order:
       .is-assembling  the six-beat entrance, removed when it finishes
       .is-settled     the ambient loops, added only after the entrance

     Running the entrance twice would restart every beat from zero, so a second
     call is a no-op. On reduced motion the field is simply settled: the scene
     is already complete and still.
     ------------------------------------------------------------------------ */
  const ASSEMBLY_MS = 1600;

  function initField() {
    const field = $("[data-planviz]");
    if (!field) return;

    if (prefersReducedMotion() || motionIsReduced()) {
      field.classList.add("is-settled");
      return;
    }

    // Start on the next frame so the browser has committed the initial state;
    // adding the class in the same frame as the first paint would skip the
    // entrance entirely on a cold load.
    requestAnimationFrame(() => {
      field.classList.add("is-assembling");
      window.setTimeout(() => {
        if (!field.isConnected) return;
        field.classList.remove("is-assembling");
        field.classList.add("is-settled");
      }, ASSEMBLY_MS);
    });
  }

  /* ------------------------------------------------------------------------
     Construction field — pointer response

     A capped 4px offset on two groups, eased by CSS. It runs only on a fine
     pointer, only while the field is on screen, and it costs one rAF per
     pointer move at most. The value written is already the eased result, so
     the CSS transition handles the smoothing and the loop can stop.
     ------------------------------------------------------------------------ */
  function initFieldPointer() {
    const field = $("[data-planviz]");
    if (!field) return;
    if (prefersReducedMotion()) return;
    if (!BM.media("(hover: hover) and (pointer: fine)").matches) return;

    const stage = $(".planviz__stage", field);
    if (!stage) return;

    let raf = 0;
    let pendingX = 0;
    let pendingY = 0;
    let visible = true;

    // 4px of travel at the very edge of the field. This is the whole effect.
    const MAX = 4;

    const apply = () => {
      raf = 0;
      if (document.hidden || !visible) return;
      field.style.setProperty("--field-x", `${pendingX.toFixed(2)}px`);
      field.style.setProperty("--field-y", `${pendingY.toFixed(2)}px`);
    };

    const onMove = (event) => {
      if (motionIsReduced()) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // -1 … 1 from the centre of the field, then scaled down to 4px.
      const nx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const ny = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      pendingX = Math.max(-1, Math.min(1, nx)) * MAX;
      pendingY = Math.max(-1, Math.min(1, ny)) * MAX * 0.6;
      if (!raf && !document.hidden) raf = requestAnimationFrame(apply);
    };

    const onLeave = () => {
      pendingX = 0;
      pendingY = 0;
      if (!raf) raf = requestAnimationFrame(apply);
    };

    // The effect is only meaningful while the hero is on screen.
    // One observer does both jobs: the pointer offset only applies while the
    // field is on screen, and the ambient loop is paused when it is not — an
    // off-screen infinite animation is battery spent on nothing.
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              visible = entries.some((entry) => entry.isIntersecting);
              field.dataset.pointer = visible ? "true" : "false";
              field.dataset.onscreen = visible ? "true" : "false";
              if (!visible) {
                pendingX = 0;
                pendingY = 0;
              }
            },
            { rootMargin: "0px" }
          )
        : null;
    if (observer) observer.observe(stage);
    field.dataset.pointer = "true";
    field.dataset.onscreen = "true";

    stage.addEventListener("pointermove", onMove, { passive: true });
    stage.addEventListener("pointerleave", onLeave, { passive: true });

    const teardown = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      if (observer) observer.disconnect();
    };

    window.addEventListener("pagehide", teardown, { once: true });
  }

  /* ------------------------------------------------------------------------
     Hero — the Roblox boundary

     The chip is a link: its default action is the real Settings deep link, so
     it works with JavaScript off and on a signed-out page. When there is a
     session and a real (non-simulated) connection service, the click is
     intercepted and routed through `connectionController.connect`, which is
     the only code in the app allowed to talk to the Roblox service. A real
     OAuth hand-off leaves the page; an unconfigured server reports
     "External integration required" in a toast and changes nothing.
     ------------------------------------------------------------------------ */
  function initRoblox() {
    const link = $("[data-hero-roblox]");
    if (!link) return;

    const chip = $("#hero-roblox-status");
    const label = chip ? $(".status__text", chip) : null;
    const controller = BM.connectionController;
    if (!chip || !label || !controller) return;

    const paint = () => {
      const connected = controller.isConnected("roblox");
      const connecting = controller.isBusy("roblox");
      label.textContent = connecting
        ? "Connecting…"
        : connected
        ? "Roblox connected"
        : "Connect Roblox";
      link.dataset.connected = connected ? "true" : "false";
      link.setAttribute("aria-busy", connecting ? "true" : "false");
    };

    paint();
    BM.subscribe?.((view, changed) => {
      if (!changed.length || changed.includes("connections") || changed.includes("auth")) paint();
    });

    link.addEventListener("click", (event) => {
      // Signed out, or running the offline demo: let the anchor do what it says
      // on the tin and open Settings, where the connection is explained in
      // full. Home never simulates a connection.
      if (!BM.isAuthenticated()) return;
      if (BM.serviceMode !== BM.SERVICE_MODES.REMOTE) return;
      if (controller.mode !== "remote") return;
      if (controller.isBusy("roblox")) {
        event.preventDefault();
        return;
      }

      // This click is a command, not a navigation: stop the document-level page
      // transition from also treating the chip's href as a link to leave for.
      event.preventDefault();
      event.stopPropagation();

      let attempt;
      try {
        attempt = controller.connect("roblox");
      } catch (error) {
        // The controller is the only caller that should ever throw here; if it
        // does, say so plainly instead of leaving a dead button.
        BM.toast("Could not start the Roblox connection.", "error");
        paint();
        return;
      }

      Promise.resolve(attempt)
        .then((result) => {
          paint();

          if (!BM.isOk(result)) {
            const failure = result.error || {};
            const message = failure.message || "Roblox is not available.";
            // `duplicate` means something is already in flight — the chip is
            // already saying so, and a toast would only repeat it.
            if (!failure.duplicate) BM.toast(message, "error");
            return;
          }

          // A real OAuth hand-off: the browser leaves for the provider.
          if (result.data && result.data.authorizeUrl) {
            window.location.assign(result.data.authorizeUrl);
            return;
          }

          if (result.data && result.data.status === "unavailable") {
            BM.toast("Roblox needs an external integration on this server.", "error");
          } else if (controller.isConnected("roblox")) {
            BM.toast("Roblox connected.");
          }
        })
        .catch(() => {
          BM.toast("Could not reach the Roblox connection.", "error");
          paint();
        });
    });
  }

  /* ------------------------------------------------------------------------
     Hero — the primary CTA

     The anchor is a plain link to build.html, so it works without any of this.
     The listener exists for one reason: the page-transition veil has to start
     in the same frame the click lands, so the outgoing hero fades with the
     document instead of snapping away. If the shell is not present, the plain
     navigation is correct and nothing is prevented.
     ------------------------------------------------------------------------ */
  function initCta() {
    const cta = $("[data-hero-cta]");
    if (!cta) return;
    if (typeof BM.initPageTransitions !== "function") return;

    cta.addEventListener("click", (event) => {
      // Modified clicks (new tab, new window, download) belong to the browser.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.defaultPrevented) return;
      const veil = $(".page-veil");
      if (!veil) return;
      veil.classList.add("is-active");
    });
  }

  /* ------------------------------------------------------------------------
     Boot — once per document.
     ------------------------------------------------------------------------ */
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    initField();
    initFieldPointer();
    initRoblox();
    initCta();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
