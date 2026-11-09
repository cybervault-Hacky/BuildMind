/* ==========================================================================
   BuildMind — services/connections/mockStudioService.js
   The Roblox Studio boundary. A separate integration from the Roblox account
   on purpose: account authorisation and a local Studio bridge are different
   problems with different failure modes, so they never share a service.

   Simulated: nothing is discovered, no bridge is opened, no plugin is loaded.

   Public surface (contracts.js envelopes, never throws):

     connect()             → { target, status, simulated, changed }
     disconnect()          → { target, status, simulated, changed }
     getConnectionState()  → { target, status, simulated }
     subscribe(listener)   → unsubscribe

   Where the real integration goes: `connect()` becomes a local bridge probe
   (a loopback handshake with the Studio plugin). The status vocabulary and
   events stay the same.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  const TARGET = "studio";
  const LABEL = "Roblox Studio";
  const SIMULATED_DELAY = 1100;
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
        console.error("[BuildMind] Studio listener failed", err);
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

  BM.studioService = createService("mockStudioService", {
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
