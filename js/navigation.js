/* ==========================================================================
   BuildMind — navigation.js
   Marks the current page for assistive technology and the CSS active
   treatment, and publishes that fact to the mobile sheet toggle.

   The visual indicator itself is pure CSS (`.nav__link[aria-current="page"]`),
   so it needs no measurement, survives a font swap without re-measuring, and
   cannot leave a floating pill behind if a link is added or removed.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind || {};

  function currentPage() {
    const path = window.location.pathname.split("/").pop() || "index.html";
    return path === "" ? "index.html" : path;
  }

  function initActiveState() {
    const page = currentPage();
    const links = Array.from(document.querySelectorAll(".nav__link, .mobile-nav__link"));

    links.forEach((link) => {
      const href = (link.getAttribute("href") || "").split("/").pop();
      if (href === page) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });

    // The sheet toggle names the current page, so a screen-reader user hears
    // where they are before opening the menu.
    const active = document.querySelector('.nav__link[aria-current="page"]');
    document.querySelectorAll(".menu-toggle").forEach((toggle) => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute(
        "aria-label",
        expanded
          ? "Close menu"
          : active
          ? `Open menu, ${active.textContent.trim()} is current`
          : "Open menu"
      );
    });
  }

  // Every page module boots once. The DOMContentLoaded guard means a second
  // dispatch (or any future re-entrant call) cannot double-register work.
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    initActiveState();

    // The sheet opens/closes with layout changes; re-publish after it settles
    // so the toggle label never describes a stale page.
    const sheet = document.querySelector(".mobile-nav");
    if (sheet) sheet.addEventListener("transitionend", initActiveState);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  BM.updateActiveNav = initActiveState;
  window.BuildMind = BM;
})();
