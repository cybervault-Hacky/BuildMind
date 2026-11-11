/* ==========================================================================
   BuildMind — js/boot-class.js
   Marks the document as script-capable before first paint.

   This is the only script that must run ahead of the stylesheets: the CSS
   uses `.js` to switch reveal-on-scroll elements from "already visible" to
   "animated in". It lives in its own file so the Content-Security-Policy can
   forbid inline scripts (`script-src 'self'`) without an exception.
   ========================================================================== */

(function () {
  "use strict";
  document.documentElement.classList.add("js");
})();
