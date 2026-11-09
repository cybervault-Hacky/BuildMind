/* ==========================================================================
   BuildMind — controllers/connectionController.js
   One connection path for both pages.

   Build and Settings both call `connectionController.toggle("roblox" | "studio")`.
   Nothing else in the app talks to robloxService or studioService, so the
   "connect → connecting → connected → disconnect" behaviour cannot drift
   between the two screens. Both integrations are simulated and labelled as
   such in the UI.

   Services report status; this controller writes it into the central store
   and persists it through settingsService. The store stays authoritative.
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

  function restore() {
    // Stored flags come through settingsService; the services stay stateless.
    const { connections } = BM.getState();
    return {
      roblox: connections.roblox.status,
      studio: connections.studio.status,
    };
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
          simulated: true,
          superseded: true,
        });
      }

      if (!BM.isOk(result)) {
        // Never leave the UI claiming a state the service did not reach.
        BM.setConnectionStatus(target, "disconnected");
        persist();
        return result;
      }

      const nextStatus = result.data.status === "connected" ? "connected" : "disconnected";
      BM.setConnectionStatus(target, nextStatus);
      persist();

      return BM.serviceOk({ target, status: nextStatus, label: LABELS[target], simulated: true });
    });
  }

  function disconnect(target) {
    const service = serviceFor(target);
    if (!service) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That integration is unknown."));
    }

    const ticket = nextAttempt(target);
    // Settle the store first: the service call is synchronous for a mock, but
    // the UI must not show "connecting" for a transition that already ended.
    BM.setConnectionStatus(target, "disconnected");

    return service.disconnect().then((result) => {
      if (!isCurrent(target, ticket)) {
        return BM.serviceOk({
          target,
          status: status(target),
          label: LABELS[target],
          simulated: true,
          superseded: true,
        });
      }

      if (!BM.isOk(result)) {
        // Never leave the UI claiming a state the service did not reach.
        BM.setConnectionStatus(target, status(target));
        return result;
      }

      BM.setConnectionStatus(target, "disconnected");
      persist();

      return BM.serviceOk({ target, status: "disconnected", label: LABELS[target], simulated: true });
    });
  }

  /** Persist both flags through the settings boundary, never by hand. */
  function persist() {
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
    mode: "mock",
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
