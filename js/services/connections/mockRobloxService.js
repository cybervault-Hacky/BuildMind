/* ==========================================================================
   BuildMind — services/connections/mockRobloxService.js
   The Roblox account boundary. Simulated: no OAuth, no request, no account.

   Public surface (contracts.js envelopes, never throws):

     connect()             → { target, status, simulated, changed }
     disconnect()          → { target, status, simulated, changed }
     getConnectionState()  → { target, status, simulated }
     subscribe(listener)   → unsubscribe  (status changes)

   Where the real integration goes: `connect()` becomes an OAuth hand-off
   (open the authorisation URL, wait for the redirect, exchange the code on a
   backend). Everything else — the status vocabulary, the events, the store
   wiring — stays exactly as it is.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  const TARGET = "roblox";
  const LABEL = "Roblox";
  const SIMULATED_DELAY = 800;
  const STATUS = { DISCONNECTED: "disconnected", CONNECTING: "connecting", CONNECTED: "connected" };

  let status = STATUS.DISCONNECTED;
  let pending = null;
  const listeners = new Set();

  function emit(next) {
    const snapshot = getConnectionState().data;
    listeners.forEach((listener) => {
      try {
        listener(snapshot, next);
      } catch (err) {
        console.error("[BuildMind] Roblox listener failed", err);
      }
    });
  }

  function setStatus(next) {
    const changed = next !== status;
    status = next;
    if (changed) emit(next);
    return changed;
  }

  function getConnectionState() {
    return ok({ target: TARGET, label: LABEL, status, simulated: true });
  }

  function connect() {
    if (status === STATUS.CONNECTED) {
      // Duplicate connects are refused rather than stacked.
      return ok({ target: TARGET, status, simulated: true, changed: false, alreadyConnected: true });
    }
    if (status === STATUS.CONNECTING) {
      return fail(ERROR_TYPES.OPERATION, "A connection is already in progress.", { duplicate: true });
    }

    setStatus(STATUS.CONNECTING);

    pending = new Promise((resolve) => {
      window.setTimeout(() => {
        pending = null;
        setStatus(STATUS.CONNECTED);
        resolve(ok({ target: TARGET, status, simulated: true, changed: true }));
      }, SIMULATED_DELAY);
    });

    return pending;
  }

  function disconnect() {
    if (status === STATUS.DISCONNECTED) {
      return ok({ target: TARGET, status, simulated: true, changed: false });
    }
    pending = null;
    setStatus(STATUS.DISCONNECTED);
    return ok({ target: TARGET, status, simulated: true, changed: true });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  BM.robloxService = createService("mockRobloxService", {
    mode: "mock",
    connect,
    disconnect,
    getConnectionState,
    subscribe,
    _reset() {
      window.clearTimeout(pending);
      pending = null;
      const changed = setStatus(STATUS.DISCONNECTED);
      listeners.clear();
      return ok({ changed });
    },
  });
})();
