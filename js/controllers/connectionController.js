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

  function connect(target) {
    const service = serviceFor(target);
    if (!service) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That integration is unknown."));
    }

    // The service owns the `connecting` status; mirror it straight away so the
    // button can be disabled in the same frame.
    BM.setConnectionStatus(target, "connecting");

    return service.connect().then((result) => {
      if (!BM.isOk(result)) {
        BM.setConnectionStatus(target, "disconnected");
        return result;
      }

      const nextStatus = result.data.status === "connected" ? "connected" : "disconnected";
      BM.setConnectionStatus(target, nextStatus);
      persist(target);

      return BM.serviceOk({ target, status: nextStatus, label: LABELS[target], simulated: true });
    });
  }

  function disconnect(target) {
    const service = serviceFor(target);
    if (!service) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That integration is unknown."));
    }

    return service.disconnect().then((result) => {
      if (!BM.isOk(result)) return result;

      BM.setConnectionStatus(target, "disconnected");
      persist(target);

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

  BM.connectionController = {
    mode: "mock",
    toggle,
    connect,
    disconnect,
    status,
    isConnected,
    restore,
    label(target) {
      return LABELS[target] || target;
    },
  };
})();
