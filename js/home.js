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
    // Preview only: no scan band, gentler pacing, pauses when the tab is hidden.
    el.dataset.ambient = "true";
    startWorldPreview(el, 0.75);
  }

  /** Walk the Idea → Build → Test → Play strip so it never feels static. */
  function initPipeline() {
    const steps = $$(".pipeline__step");
    if (!steps.length || prefersReducedMotion()) return;

    let index = 0;

    const paint = () => {
      steps.forEach((step, i) => {
        step.classList.toggle("is-live", i === index);
        step.classList.toggle("is-past", i < index);
      });
    };

    paint();

    window.setInterval(() => {
      if (document.hidden) return;
      index = (index + 1) % steps.length;
      paint();
    }, 2200);
  }

  function init() {
    initWorld();
    initPipeline();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
