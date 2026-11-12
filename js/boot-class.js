/* ==========================================================================
   BuildMind — js/boot-class.js
   Marks the document as script-capable before first paint.

   This is the only script that must run ahead of the stylesheets: the CSS
   uses `.js` to switch reveal-on-scroll elements from "already visible" to
   "animated in". It lives in its own file so the Content-Security-Policy can
   forbid inline scripts (`script-src 'self'`) without an exception.

   It also publishes the initial authentication state. The real value is
   written by the auth controller once the session check has answered; until
   then the page is in the `loading` state, which the CSS uses to hide both
   the signed-in and the signed-out regions. That is what stops the page from
   flashing a signed-in layout that it then has to hide.
   ========================================================================== */

(function () {
  "use strict";
  document.documentElement.classList.add("js");
  document.documentElement.setAttribute("data-auth-state", "loading");
})();
