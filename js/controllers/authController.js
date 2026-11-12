/* ==========================================================================
   BuildMind — controllers/authController.js
   The only writer of the authentication slice.

   Bootstrap (once per page):

       Application starts
               ↓
       Check backend session
               ↓
       Authenticated?  /            \
            yes                    no
             ↓                       ↓
        Load user              Public state

   While the check is in flight the page is in the `loading` state: the
   signed-in regions are hidden and the signed-out regions are hidden too, so
   nothing flashes and nothing lies. The first paint after the check shows
   exactly one of the two.

   An expired session is detected centrally: the API client reports every
   401, and this controller clears the signed-in state and shows the sign-in
   state. It never falls back to a simulated experience.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES, AUTH_STATUS } = BM;

  let bootstrapped = false;
  let unsubscribers = [];

  /* ------------------------------------------------------------------------
     DOM reflection

     The page's authentication state is published as `data-auth-state` on the
     document element. CSS does the gating, so no page script has to hide
     anything by hand and no page can disagree with another about who is
     signed in.
     ------------------------------------------------------------------------ */
  function reflect() {
    const status = BM.getState().auth.status;
    if (document.documentElement) {
      document.documentElement.setAttribute("data-auth-state", status);
    }
  }

  function apply(patch) {
    BM.setAuth(patch);
    reflect();
  }

  /* ------------------------------------------------------------------------
     Session lifecycle
     ------------------------------------------------------------------------ */
  function bootstrap(options) {
    if (bootstrapped) {
      return Promise.resolve(BM.serviceOk(BM.getState().auth));
    }
    bootstrapped = true;

    apply({ status: AUTH_STATUS.LOADING, error: null });

    return BM.authService.initialize(options).then((result) => {
      if (!BM.isOk(result)) {
        // The service could not be reached. That is an error, not a
        // signed-out state: the difference matters, because one of them
        // invites the user to sign in and the other does not.
        apply({
          status: AUTH_STATUS.ERROR,
          user: null,
          error: result.error ? result.error.message : "The service could not be reached.",
          checkedAt: Date.now(),
        });
        return result;
      }

      const data = result.data || {};
      apply({
        status: data.authenticated ? AUTH_STATUS.AUTHENTICATED : AUTH_STATUS.UNAUTHENTICATED,
        user: data.authenticated ? data.user || null : null,
        error: null,
        expiresAt: data.expiresAt || null,
        checkedAt: Date.now(),
      });
      return result;
    });
  }

  function register(input, options) {
    return BM.authService.register(input, options).then((result) => {
      if (!BM.isOk(result)) {
        apply({ status: BM.getState().auth.status, error: null });
        return result;
      }
      apply({
        status: AUTH_STATUS.AUTHENTICATED,
        user: result.data.user || null,
        error: null,
        expiresAt: result.data.expiresAt || null,
        checkedAt: Date.now(),
      });
      return result;
    });
  }

  function login(input, options) {
    return BM.authService.login(input, options).then((result) => {
      if (!BM.isOk(result)) {
        apply({ status: BM.getState().auth.status, error: null });
        return result;
      }
      apply({
        status: AUTH_STATUS.AUTHENTICATED,
        user: result.data.user || null,
        error: null,
        expiresAt: result.data.expiresAt || null,
        checkedAt: Date.now(),
      });
      return result;
    });
  }

  function clearSessionData() {
    BM.sse?.closeAll?.("auth-clear");
    BM.aiService?._reset?.();
    BM.buildController?.reset?.();
    BM.setProjects?.([]);
    BM.setProjectsStatus?.("idle", null);
    BM.setActiveProject?.("");
    BM.setApiKeyPresent?.(false);
    BM.setProviderValidation?.({
      status: BM.PROVIDER_VALIDATION.NOT_CONFIGURED,
      detail: "",
      provider: "",
      model: "",
      checkedAt: 0,
    });
    if (BM.serviceMode === BM.SERVICE_MODES.REMOTE) {
      BM.setConnectionStatus?.("roblox", "disconnected");
      BM.setConnectionStatus?.("studio", "disconnected");
    }
  }

  function logout(options) {
    return BM.authService.logout(options).then((result) => {
      clearSessionData();
      // Signing out always lands on the signed-out state, whether the server
      // confirmed it or not: the cookie is gone either way.
      apply({
        status: AUTH_STATUS.UNAUTHENTICATED,
        user: null,
        error: null,
        expiresAt: null,
        checkedAt: Date.now(),
      });
      return result;
    });
  }

  /** The session expired server-side: drop the signed-in state, show sign-in. */
  function handleSessionExpired() {
    if (BM.getState().auth.status !== AUTH_STATUS.AUTHENTICATED) {
      // Already signed out; nothing to clear.
      if (BM.getState().auth.status === AUTH_STATUS.LOADING) {
        apply({ status: AUTH_STATUS.UNAUTHENTICATED, user: null, checkedAt: Date.now() });
      }
      return;
    }
    BM.authService?.forget?.();
    clearSessionData();
    apply({
      status: AUTH_STATUS.UNAUTHENTICATED,
      user: null,
      error: null,
      expiresAt: null,
      checkedAt: Date.now(),
    });
    BM.toast?.("Your session ended. Sign in to continue.");
  }

  /* ------------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------------ */
  function init() {
    if (unsubscribers.length) return;

    // A 401 anywhere in the app ends the signed-in state, everywhere.
    unsubscribers.push(BM.api.onSessionExpired(() => handleSessionExpired()));

    // The server summary is derived from the request lifecycle, so the UI can
    // say "Loading projects…" without every page counting its own requests.
    let pending = 0;
    unsubscribers.push(
      BM.api.onRequestState((name, entry) => {
        if (entry.status === "loading") pending += 1;
        else pending = Math.max(0, pending - 1);

        const status =
          entry.status === "error" && entry.error && entry.error.type === ERROR_TYPES.CONNECTION
            ? "error"
            : pending > 0
            ? "loading"
            : "ready";

        BM.setServerState({
          status,
          pending,
          lastError: entry.status === "error" ? entry.error : BM.getState().server.lastError,
        });
      })
    );

    reflect();
  }

  BM.authController = {
    mode: "remote",
    bootstrap,
    register,
    login,
    logout,
    init,
    handleSessionExpired,
    status: () => BM.getState().auth.status,
    user: () => BM.getState().auth.user,
    isAuthenticated: () => BM.isAuthenticated(),
    _reset() {
      bootstrapped = false;
      unsubscribers.forEach((off) => {
        if (typeof off === "function") off();
      });
      unsubscribers = [];
      BM.authService?._reset?.();
      apply({ status: AUTH_STATUS.LOADING, user: null, error: null, expiresAt: null, checkedAt: 0 });
      return BM.serviceOk(null);
    },
  };
})();
