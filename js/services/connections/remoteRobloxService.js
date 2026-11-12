/* ==========================================================================
   BuildMind — services/connections/remoteRobloxService.js
   The real Roblox account boundary.

   It implements the same surface as mockRobloxService.js, so the connection
   controller and both pages are unchanged:

     connect()             → { target, status, authorizeUrl?, … }
     disconnect()          → { target, status, … }
     getConnectionState()  → { target, status, connected, configured, account }
     subscribe(listener)   → unsubscribe

   Honesty properties:
     * "connected" is only ever reported when the backend says the account is
       connected. There is no local flag and no optimistic UI.
     * when the server has no Roblox integration configured, the service
       reports `unavailable` — the UI then says an external integration is
       required. It never pretends a connection exists.
     * the OAuth `state` is a single-use value the server minted; it is never
       stored in the browser. The provider returns it in the redirect, and
       the callback posts it straight back.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  const TARGET = "roblox";
  const LABEL = "Roblox";

  /** The copy shown when the server has no Roblox integration configured. */
  const NOT_CONFIGURED = "External integration required";

  let listeners = new Set();

  function emit(snapshot) {
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[BuildMind] Roblox listener failed", err);
      }
    });
  }

  function shape(data) {
    const configured = Boolean(data && data.configured);
    const connected = Boolean(data && data.connected);
    return {
      target: TARGET,
      label: LABEL,
      status: connected ? "connected" : configured ? "disconnected" : "unavailable",
      connected,
      configured,
      account: (data && data.account) || null,
      capabilities: (data && data.capabilities) || null,
      simulated: false,
    };
  }

  function getConnectionState(options) {
    return BM.api.robloxStatus(options).then((result) => {
      if (!BM.isOk(result)) {
        return fail(
          result.error ? result.error.type : ERROR_TYPES.CONNECTION,
          (result.error && result.error.message) || "Roblox could not be reached.",
          { status: "unavailable" }
        );
      }
      const snapshot = shape(result.data);
      emit(snapshot);
      return ok(snapshot);
    });
  }

  /**
   * Begin the OAuth flow.
   *
   * The backend mints the state and returns the authorisation URL. The
   * browser is sent there; the provider sends the user back with a code and
   * the state, and the callback endpoint completes it.
   */
  function connect(options) {
    return BM.api.robloxConnect(options).then((result) => {
      if (!BM.isOk(result)) {
        const code = result.error && result.error.code;
        const message =
          code === "ROBLOX_NOT_CONFIGURED"
            ? NOT_CONFIGURED
            : (result.error && result.error.message) || "Roblox could not be connected.";
        return fail(
          result.error ? result.error.type : ERROR_TYPES.CONNECTION,
          message,
          { code, status: "unavailable" }
        );
      }

      return ok({
        target: TARGET,
        label: LABEL,
        status: "connecting",
        authorizeUrl: result.data.authorizeUrl || "",
        changed: true,
        simulated: false,
      });
    });
  }

  function disconnect(options) {
    return BM.api.robloxDisconnect(options).then((result) => {
      if (!BM.isOk(result)) {
        return fail(
          result.error ? result.error.type : ERROR_TYPES.CONNECTION,
          (result.error && result.error.message) || "Roblox could not be disconnected.",
          { status: "unavailable" }
        );
      }
      const snapshot = shape(result.data);
      emit(snapshot);
      return ok({ ...snapshot, changed: true });
    });
  }

  /** Complete the OAuth flow with the code and state the provider returned. */
  function complete(code, state, options) {
    return BM.api.request("POST", "/api/v1/roblox/callback", {
      body: { code, state },
      name: "roblox.callback",
      ...(options || {}),
    }).then((result) => {
      if (!BM.isOk(result)) return result;
      const snapshot = shape(result.data);
      emit(snapshot);
      return ok(snapshot);
    });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  BM.remoteRobloxService = createService("remoteRobloxService", {
    mode: "remote",
    connect,
    disconnect,
    complete,
    getConnectionState,
    subscribe,
    _reset() {
      listeners = new Set();
      return ok(null);
    },
  });
})();
