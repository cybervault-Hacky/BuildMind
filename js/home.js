/* ==========================================================================
   BuildMind — home.js
   Home page behaviour: the living world preview and the pipeline highlight.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { $, $$, startWorldPreview, prefersReducedMotion } = BM;

  function initWorld() {
    const el = $("#hero-world");
    if (!el) return;
    // Preview only: no scan band, gentler pacing, pauses when the tab is hidden
    // or the visualizer is scrolled out of view.
    el.dataset.ambient = "true";
    const stop = startWorldPreview(el, 0.75);
    // The home page never unmounts, but a bfcache restore or a future teardown
    // must not leave the loop running.
    window.addEventListener("pagehide", stop, { once: true });
  }

  /** Walk the Idea → Build → Test → Play strip so it never feels static. */
  function initPipeline() {
    const steps = $$(".pipeline__step");
    if (!steps.length || prefersReducedMotion()) return;

    let index = 0;

    const paint = () => {
      steps.forEach((step, i) => {
        // Compare before writing: toggle() queues a mutation record even when
        // the class already matches, and this runs on a permanent clock.
        const live = i === index;
        const past = i < index;
        if (step.classList.contains("is-live") !== live) step.classList.toggle("is-live", live);
        if (step.classList.contains("is-past") !== past) step.classList.toggle("is-past", past);
      });
    };

    paint();

    // The strip only walks while it is on screen and the tab is visible; the
    // interval is owned here so it can be retired on pagehide.
    let visible = true;
    let timer = 0;

    const tick = () => {
      if (document.hidden || !visible) return;
      index = (index + 1) % steps.length;
      paint();
    };

    const start = () => {
      if (timer) return;
      timer = window.setInterval(tick, 2200);
    };

    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            if (visible) start();
          }, { rootMargin: "80px" })
        : null;

    if (observer) observer.observe(steps[0].parentElement || steps[0]);
    start();

    window.addEventListener(
      "pagehide",
      () => {
        window.clearInterval(timer);
        timer = 0;
        if (observer) observer.disconnect();
      },
      { once: true }
    );
  }

  // Every page module boots once. The DOMContentLoaded guard means a second
  // dispatch (or any future re-entrant call) cannot double-register the
  // listeners and interval below — measured before this guard: a repeated
  // init on build.html took the live listener count from 36 to 69.
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    initWorld();
    initPipeline();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
