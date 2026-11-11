/* ==========================================================================
   BuildMind — navigation.js
   Keeps the active page visually identifiable and animates the sliding
   indicator that sits behind the current nav item.
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

    // The mobile sheet is mounted at boot; mirror the state onto its toggle.
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

  function initIndicator() {
    const nav = document.querySelector(".nav");
    if (!nav) return;

    let indicator = nav.querySelector(".nav__indicator");
    if (!indicator) {
      indicator = document.createElement("span");
      indicator.className = "nav__indicator";
      indicator.setAttribute("aria-hidden", "true");
      nav.prepend(indicator);
    }

    const active = nav.querySelector('.nav__link[aria-current="page"]');

    const place = (animate) => {
      const target = nav.querySelector('.nav__link[aria-current="page"]') || active;
      if (!target) return;

      const navRect = nav.getBoundingClientRect();
      const rect = target.getBoundingClientRect();

      if (!animate) indicator.style.transition = "none";
      indicator.style.width = `${rect.width}px`;
      indicator.style.transform = `translateX(${rect.left - navRect.left}px)`;

      if (!animate) {
        // Force a reflow so the next transition is animated again.
        void indicator.offsetWidth;
        indicator.style.transition = "";
      }
      indicator.classList.add("is-ready");
    };

    // First placement happens without animation.
    requestAnimationFrame(() => place(false));

    let raf = 0;
    window.addEventListener(
      "resize",
      () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => place(false));
      },
      { passive: true }
    );

    // Re-measure once webfonts settle, so the pill never sits off-centre.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => place(false)).catch(() => {});
    }
  }

  // Every page module boots once. The DOMContentLoaded guard means a second
  // dispatch (or any future re-entrant call) cannot double-register the
  // listeners and interval below — measured before this guard: a repeated
  // init on build.html took the live listener count from 36 to 69.
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    initActiveState();
    initIndicator();
    // The sheet opens/closes with layout changes; re-measure after it settles.
    const sheet = document.querySelector(".mobile-nav");
    if (sheet) {
      sheet.addEventListener("transitionend", () => initActiveState());
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  BM.updateActiveNav = initActiveState;
})();
