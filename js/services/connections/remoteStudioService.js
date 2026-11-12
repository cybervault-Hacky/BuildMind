/* ==========================================================================
   BuildMind — services/connections/remoteStudioService.js
   The real Roblox Studio boundary.

   Same surface as mockStudioService.js:

     connect()             → { target, status, … }
     disconnect()          → { target, status, … }
     getConnectionState()  → { target, status, sessionActive, deliveries }
     subscribe(listener)   → unsubscribe

   The Studio bridge is a desktop integration: a plugin inside Roblox Studio
   registers with the API and reports back. A web page cannot become the
   plugin, so this service never claims a connection it did not observe.

   What it does:
     * reads the real status from the backend (`/studio/status`), which knows
       whether a plugin has registered and what it delivered
     * reports `unavailable` with an explanation when there is no session,
       instead of pretending one exists

   The session token is never minted here. `/studio/session` hands a token to
   whoever calls it, and a browser page is not the party that should hold
   it; the plugin registers for itself.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  const TARGET = "studio";
  const LABEL = "Roblox Studio";

  /** Shown when no plugin has registered with the backend. */
  const NO_PLUGIN = "Connect Roblox Studio from the Studio plugin.";

  let listeners = new Set();

  function emit(snapshot) {
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[BuildMind] Studio listener failed", err);
      }
    });
  }

  function shape(data) {
    const sessionActive = Boolean(data && data.sessionActive);
    return {
      target: TARGET,
      label: LABEL,
      status: sessionActive ? "connected" : "unavailable",
      connected: sessionActive,
      sessionActive,
      protocolVersion: (data && data.protocolVersion) || null,
      deliveries: (data && data.deliveries) || [],
      simulated: false,
    };
  }

  function getConnectionState(options) {
    return BM.api.studioStatus(options).then((result) => {
      if (!BM.isOk(result)) {
        return fail(
          result.error ? result.error.type : ERROR_TYPES.CONNECTION,
          (result.error && result.error.message) || "No Studio session is connected.",
          { status: "unavailable" }
        );
      }
      const snapshot = shape(result.data);
      emit(snapshot);
      return ok(snapshot);
    });
  }

  /**
   * A page cannot open the Studio bridge. The honest answer is a refusal with
   * an explanation, not a simulated connection.
   */
  function connect() {
    return Promise.resolve(
      fail(ERROR_TYPES.CONFIGURATION, NO_PLUGIN, { status: "unavailable" })
    );
  }

  /**
   * A Studio session is owned by the plugin that registered it, and the
   * status endpoint does not expose its id — so a page cannot revoke it.
   * The honest answer is the current state, read from the backend.
   */
  function disconnect(options) {
    return getConnectionState(options).then((result) => {
      if (!BM.isOk(result)) return result;
      return ok({ ...result.data, changed: false });
    });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  BM.remoteStudioService = createService("remoteStudioService", {
    mode: "remote",
    connect,
    disconnect,
    getConnectionState,
    subscribe,
    _reset() {
      listeners = new Set();
      return ok(null);
    },
  });
})();
