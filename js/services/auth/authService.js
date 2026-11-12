/* ==========================================================================
   BuildMind — services/auth/authService.js
   The authentication boundary.

   It is a thin, honest wrapper over the API client: it performs no
   simulation, stores nothing and never keeps a secret. The session lives in
   an HttpOnly cookie the browser attaches to every request; the only thing
   this service holds is what the server chose to tell the page — the user
   record and the CSRF token (which lives inside the API client, in memory).

   Every method resolves to the contracts.js envelope and never throws.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  /** The session as the page knows it. Never contains a token. */
  let session = { authenticated: false, user: null, expiresAt: null };

  function adopt(data) {
    if (!data) return session;
    session = {
      authenticated: Boolean(data.authenticated),
      user: data.user || null,
      expiresAt: data.expiresAt || null,
    };
    return session;
  }

  /**
   * Ask the backend who we are.
   *
   * A signed-out visitor is not an error: the endpoint answers 200 with
   * `authenticated: false`. A network failure *is* an error, and is reported
   * as one — the page must never quietly turn it into "signed out".
   */
  function initialize(options) {
    return BM.api.me(options).then((result) => {
      if (!BM.isOk(result)) return result;
      adopt(result.data);
      return ok({ ...session });
    });
  }

  function register(input, options) {
    const payload = {
      email: String(input && input.email ? input.email : "").trim(),
      password: String(input && input.password ? input.password : ""),
      ...(input && input.displayName ? { displayName: String(input.displayName) } : {}),
    };
    return BM.api.register(payload, options).then((result) => {
      if (!BM.isOk(result)) return result;
      adopt({ authenticated: true, user: result.data.user, expiresAt: result.data.expiresAt });
      return ok({ ...session });
    });
  }

  function login(input, options) {
    const payload = {
      email: String(input && input.email ? input.email : "").trim(),
      password: String(input && input.password ? input.password : ""),
    };
    return BM.api.login(payload, options).then((result) => {
      if (!BM.isOk(result)) return result;
      adopt({ authenticated: true, user: result.data.user, expiresAt: result.data.expiresAt });
      return ok({ ...session });
    });
  }

  function logout(options) {
    return BM.api.logout(options).then((result) => {
      // The local view of the session is cleared whether or not the server
      // confirmed: the cookie is gone either way once the response lands.
      session = { authenticated: false, user: null, expiresAt: null };
      return BM.isOk(result) ? result : result;
    });
  }

  /** The session as it currently stands. */
  function current() {
    return { ...session };
  }

  function isAuthenticated() {
    return session.authenticated === true;
  }

  /** Drop the local view of the session (used when it expires server-side). */
  function forget() {
    session = { authenticated: false, user: null, expiresAt: null };
    return { ...session };
  }

  BM.authService = createService("auth", {
    mode: "remote",
    initialize,
    register,
    login,
    logout,
    current,
    isAuthenticated,
    forget,
    _reset() {
      session = { authenticated: false, user: null, expiresAt: null };
      return ok(null);
    },
  });
})();
