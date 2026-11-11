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
  /**
   * Bumped on every accepted transition. A late callback from a superseded
   * attempt compares its ticket and returns without touching status, so a
   * disconnect during a connect can never be overwritten by that connect
   * finishing afterwards.
   */
  let ticket = 0;
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

  /**
   * A connect resolves to the state that ended the attempt, which is not always
   * "connected": a disconnect (or a reset) can supersede it mid-flight. Callers
   * are told `superseded` so they do not report success that did not happen.
   */
  function connect() {
    if (status === STATUS.CONNECTED) {
      return ok({ target: TARGET, status, simulated: true, changed: false, alreadyConnected: true });
    }
    if (status === STATUS.CONNECTING) {
      return fail(ERROR_TYPES.OPERATION, "A connection is already in progress.", { duplicate: true });
    }

    setStatus(STATUS.CONNECTING);

    const mine = (ticket += 1);
    pending = new Promise((resolve) => {
      window.setTimeout(() => {
        // Superseded by a disconnect (or a reset) while this was in flight.
        if (mine !== ticket) {
          resolve(
            ok({ target: TARGET, status, simulated: true, changed: false, superseded: true })
          );
          return;
        }
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
    // Invalidate any in-flight connect and drop the timer's right to settle.
    ticket += 1;
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
      ticket += 1;
      pending = null;
      const changed = setStatus(STATUS.DISCONNECTED);
      listeners.clear();
      return ok({ changed });
    },
  });
})();
