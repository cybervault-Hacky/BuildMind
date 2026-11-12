/* ==========================================================================
   BuildMind — controllers/connectionController.js
   One connection path for both pages.

   Build and Settings both call `connectionController.toggle("roblox" | "studio")`.
   Nothing else in the app talks to robloxService or studioService, so the
   "connect → connecting → connected → disconnect" behaviour cannot drift
   between the two screens.

   Services report status; this controller writes it into the central store.
   The store stays authoritative.

   In `remote` mode the status comes from the backend and is never written to
   the browser: a flag in localStorage would be a second source of truth, and
   it would be a lie after a reload.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES } = BM;

  const SERVICES = {
    roblox: () => BM.robloxService,
    studio: () => BM.studioService,
  };

  const LABELS = { roblox: "Roblox", studio: "Studio" };

  function serviceFor(target) {
    const factory = SERVICES[target];
    return factory ? factory() : null;
  }

  function status(target) {
    const view = BM.getState();
    return view.connections[target] ? view.connections[target].status : "disconnected";
  }

  function isConnected(target) {
    return status(target) === "connected";
  }

  /** True when the app is talking to the real backend. */
  function isRemote() {
    return BM.serviceMode === BM.SERVICE_MODES.REMOTE;
  }

  /**
   * Read the current status.
   *
   * In remote mode this asks the backend, which is the only authority on
   * whether an account is connected. In the simulated mode there is nothing
   * to ask, so the store's own value is the answer.
   */
  function restore() {
    const results = { roblox: status("roblox"), studio: status("studio") };

    if (!isRemote()) return Promise.resolve(BM.serviceOk(results));
    if (!BM.isAuthenticated()) {
      BM.setConnectionStatus("roblox", "disconnected");
      BM.setConnectionStatus("studio", "disconnected");
      return Promise.resolve(BM.serviceOk({ roblox: "disconnected", studio: "disconnected" }));
    }

    return Promise.all(
      ["roblox", "studio"].map((target) => {
        const service = serviceFor(target);
        if (!service || typeof service.getConnectionState !== "function") {
          return Promise.resolve(null);
        }
        return service.getConnectionState().then((result) => {
          if (!BM.isOk(result)) {
            // The integration is not reachable: say so, never "connected".
            BM.setConnectionStatus(target, "unavailable");
            return null;
          }
          BM.setConnectionStatus(target, result.data.status || "disconnected");
          return result.data;
        });
      })
    ).then(() => BM.serviceOk(results));
  }

  /**
   * Connect or disconnect, depending on the current status.
   * @returns {Promise<{ok:boolean,data?:object,error?:object}>}
   */
  function toggle(target) {
    const service = serviceFor(target);
    if (!service) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That integration is unknown."));
    }

    const current = status(target);

    if (current === "connecting") {
      return Promise.resolve(
        BM.serviceFail(ERROR_TYPES.OPERATION, "A connection is already in progress.", { duplicate: true })
      );
    }

    if (current === "connected") return disconnect(target);
    return connect(target);
  }

  /**
   * Per-target attempt counters. A callback from an attempt that has been
   * superseded (disconnect during connect, a reset, a second navigation)
   * compares its ticket and refuses to repaint an old status.
   */
  const attempts = { roblox: 0, studio: 0 };

  function nextAttempt(target) {
    attempts[target] += 1;
    return attempts[target];
  }

  function isCurrent(target, ticket) {
    return attempts[target] === ticket;
  }

  function connect(target) {
    const service = serviceFor(target);
    if (!service) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That integration is unknown."));
    }

    // A second connect must not supersede the one already in flight: it would
    // invalidate the first attempt's ticket and leave the store behind the
    // service. Refuse before touching the ticket.
    if (status(target) === "connecting") {
      return Promise.resolve(
        BM.serviceFail(ERROR_TYPES.OPERATION, "A connection is already in progress.", { duplicate: true })
      );
    }

    const ticket = nextAttempt(target);
    // The service owns the `connecting` status; mirror it straight away so the
    // button can be disabled in the same frame.
    BM.setConnectionStatus(target, "connecting");

    return service.connect().then((result) => {
      // A disconnect (or reset) happened while this was in flight: report what
      // the store actually says now instead of resurrecting the old status.
      if (!isCurrent(target, ticket)) {
        return BM.serviceOk({
          target,
          status: status(target),
          label: LABELS[target],
          superseded: true,
        });
      }

      if (!BM.isOk(result)) {
        // Never leave the UI claiming a state the service did not reach.
        BM.setConnectionStatus(target, result.error && result.error.status ? result.error.status : "disconnected");
        persist();
        return result;
      }

      // The service states the outcome. "unavailable" is an honest answer
      // when the server has no such integration configured.
      const nextStatus = result.data.status || "disconnected";
      BM.setConnectionStatus(target, nextStatus);
      persist();

      return BM.serviceOk({
        target,
        status: nextStatus,
        label: LABELS[target],
        ...(result.data.authorizeUrl ? { authorizeUrl: result.data.authorizeUrl } : {}),
        ...(result.data.simulated === undefined ? {} : { simulated: result.data.simulated }),
      });
    });
  }

  function disconnect(target) {
    const service = serviceFor(target);
    if (!service) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That integration is unknown."));
    }

    const ticket = nextAttempt(target);
    // Settle the store first: the service call may be synchronous for a mock,
    // but the UI must not show "connecting" for a transition that already ended.
    BM.setConnectionStatus(target, "disconnected");

    return service.disconnect().then((result) => {
      if (!isCurrent(target, ticket)) {
        return BM.serviceOk({
          target,
          status: status(target),
          label: LABELS[target],
          superseded: true,
        });
      }

      if (!BM.isOk(result)) {
        // Never leave the UI claiming a state the service did not reach.
        BM.setConnectionStatus(target, status(target));
        return result;
      }

      BM.setConnectionStatus(target, result.data.status || "disconnected");
      persist();

      return BM.serviceOk({ target, status: status(target), label: LABELS[target] });
    });
  }

  /**
   * Persist both flags through the settings boundary, never by hand.
   *
   * Only the simulated mode persists: in remote mode the backend owns the
   * state, and a local flag would be a second source of truth.
   */
  function persist() {
    if (isRemote()) return;
    BM.settingsService.saveSettings({
      connections: {
        roblox: isConnected("roblox"),
        studio: isConnected("studio"),
      },
    });
  }

  /** True while a target is mid-transition — the UI's disable signal. */
  function isBusy(target) {
    return status(target) === "connecting";
  }

  BM.connectionController = {
    mode: "remote",
    toggle,
    connect,
    disconnect,
    status,
    isConnected,
    isBusy,
    restore,
    label(target) {
      return LABELS[target] || target;
    },
  };
})();
