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
    startWorldPreview(el, 1);
  }

  /** Walk the Idea → Build → Test → Play strip so it never feels static. */
  function initPipeline() {
    const steps = $$(".pipeline__step");
    if (!steps.length || prefersReducedMotion()) return;

    let index = 0;

    window.setInterval(() => {
      if (document.hidden) return;
      steps.forEach((step, i) => {
        step.classList.toggle("is-live", i === index);
      });
      index = (index + 1) % steps.length;
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
