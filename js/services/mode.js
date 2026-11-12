/* ==========================================================================
   BuildMind — services/mode.js
   Chooses which service implementation the app runs against, and states it.

   The rule this file exists to enforce: the app must never *silently* fall
   back from the real backend to the simulation.

       remote      the real BuildMind API. The default, and the only mode a
                   production deployment uses. If the API is unreachable the
                   app says so and shows the error state — it never invents a
                   build, a project or a signed-in user.
       simulated   an explicit, labelled offline demo. It is reached only when
                   a deployment asks for it (`?mode=simulated`, or
                   `window.BM_CONFIG.mode = "simulated"`), never as a fallback
                   and never because a request failed.

   The mode is decided once, from an explicit setting, and is published as
   `BM.serviceMode` so the UI can always tell the user which one is live.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const MODES = {
    SIMULATED: "simulated",
    REMOTE: "remote",
  };

  /**
   * The local implementations assign `BM.aiService` / `BM.projectService`
   * directly when they load, with no separate handle. Capture them the moment
   * this file runs (it is loaded after them), so switching modes later never
   * has to guess where the simulated implementation went.
   */
  const LOCAL = {
    ai: BM.aiService,
    projects: BM.projectService,
    connections: {
      roblox: BM.robloxService,
      studio: BM.studioService,
    },
  };

  /** The remote implementations, captured the same way. */
  const REMOTE = {
    ai: BM.remoteAIService,
    projects: BM.remoteProjectService,
    connections: {
      roblox: BM.remoteRobloxService,
      studio: BM.remoteStudioService,
    },
  };

  function requested() {
    const config = window.BM_CONFIG || {};

    /*
      Three ways to ask for a mode, in priority order:
        1. an explicit global config (window.BM_CONFIG.mode)
        2. `?mode=simulated` / `?mode=remote` — how a deployment or a test
           opts in without rebuilding anything
        3. anything else: the real backend.
      The API base URL is configuration for both modes and is applied
      whatever the mode is.
    */
    const query =
      typeof window.location === "object" && window.location.search
        ? new URLSearchParams(window.location.search).get("mode")
        : null;

    const explicit = config.mode || window.__BUILDMIND_MODE__ || query;
    if (explicit === MODES.SIMULATED) return MODES.SIMULATED;
    return MODES.REMOTE;
  }

  /**
   * Install the services for `mode`. Returns the mode that is actually live.
   * It does not probe the network: probing on boot would make the first paint
   * depend on a request, and the mode must be knowable synchronously.
   *
   * The remote mode never degrades to the simulation. If the remote services
   * are missing, the app stays in remote mode and reports that the services
   * are unavailable — which is the truth.
   */
  function install(mode) {
    const chosen = mode === MODES.SIMULATED ? MODES.SIMULATED : MODES.REMOTE;

    // The mode is published on the document element before the first paint,
    // so the CSS can gate the page from the very first frame.
    if (document.documentElement) {
      document.documentElement.setAttribute("data-service-mode", chosen);
    }

    // The API base URL is transport configuration, independent of the mode.
    if (window.BM_CONFIG && typeof window.BM_CONFIG.apiBaseUrl === "string") {
      BM.api.configure({ baseUrl: window.BM_CONFIG.apiBaseUrl });
    }

    if (chosen === MODES.REMOTE) {
      const missing =
        !REMOTE.ai ||
        !REMOTE.projects ||
        !REMOTE.connections.roblox ||
        !REMOTE.connections.studio;

      if (missing) {
        // A load-order regression: the mode layer ran before the services it
        // needs. Do not pretend: stay in remote mode and say the services are
        // unavailable.
        BM.serviceMode = MODES.REMOTE;
        BM.servicesReady = false;
        console.error("[BuildMind] Remote services failed to load; the API is unavailable.");
        return BM.serviceMode;
      }

      BM.aiService = REMOTE.ai;
      BM.projectService = REMOTE.projects;
      BM.robloxService = REMOTE.connections.roblox;
      BM.studioService = REMOTE.connections.studio;
      BM.serviceMode = MODES.REMOTE;
      BM.servicesReady = true;
      return BM.serviceMode;
    }

    // The simulated mode is an explicit, labelled demo. It is never entered
    // because a real request failed.
    if (!LOCAL.ai || !LOCAL.projects) {
      BM.serviceMode = MODES.REMOTE;
      BM.servicesReady = false;
      console.error("[BuildMind] Simulated services were not captured at load");
      return BM.serviceMode;
    }

    BM.aiService = LOCAL.ai;
    BM.projectService = LOCAL.projects;
    if (LOCAL.connections.roblox) BM.robloxService = LOCAL.connections.roblox;
    if (LOCAL.connections.studio) BM.studioService = LOCAL.connections.studio;
    BM.serviceMode = MODES.SIMULATED;
    BM.servicesReady = true;
    return BM.serviceMode;
  }

  Object.assign(BM, {
    SERVICE_MODES: MODES,
    requestedServiceMode: requested,
    installServices: install,
    serviceMode: null,
    servicesReady: false,
  });
})();
