/* ==========================================================================
   BuildMind — services/mode.js
   Chooses which service implementation the app runs against, and states it.

   The rule this file exists to enforce: the app must never *silently* fall
   back from the real backend to the simulation. So:

     * the mode is decided once, from an explicit setting
       (`BM_CONFIG.mode` in api config, or window.__BUILDMIND_MODE__)
     * `simulated` is the default only because the static frontend must work
       with no backend at all (that is its documented deployment)
     * `remote` never falls back: if the backend is unreachable, the app says
       so and stays in remote mode rather than quietly simulating a build

   The chosen mode is exposed as `BM.serviceMode` and rendered in the UI
   (see settings.js / build.js), so a user can always tell which one is live.
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
  };

  function requested() {
    const config = window.BM_CONFIG || {};

    /*
      Three ways to ask for a mode, in priority order:
        1. an explicit global config (window.BM_CONFIG.mode)
        2. a `?mode=remote` query parameter — this is how a deployment or a
           test opts in without rebuilding anything
        3. an API base URL, which only makes sense against a backend
      Anything else stays simulated, which is the documented static default.
    */
    const query =
      typeof window.location === "object" && window.location.search
        ? new URLSearchParams(window.location.search).get("mode")
        : null;

    const explicit = config.mode || window.__BUILDMIND_MODE__ || query;
    if (explicit === MODES.REMOTE || explicit === MODES.SIMULATED) return explicit;

    // A page served from an API origin (or with an explicit API base) is
    // treated as remote; a plain static page stays simulated.
    if (config.apiBaseUrl) return MODES.REMOTE;
    return MODES.SIMULATED;
  }

  /**
   * Install the services for `mode`. Returns the mode that is actually live.
   * It does not probe the network: probing on boot would make the first paint
   * depend on a request, and the mode must be knowable synchronously.
   */
  function install(mode) {
    const chosen = mode === MODES.REMOTE ? MODES.REMOTE : MODES.SIMULATED;

    if (!LOCAL.ai || !LOCAL.projects) {
      // A load-order regression: the mode layer ran before the services it
      // needs to fall back to. Fail loudly rather than booting with nothing.
      throw new Error("[BuildMind] mode.js must load after the local services");
    }

    if (chosen === MODES.REMOTE && (!BM.remoteAIService || !BM.remoteProjectService)) {
      // The remote implementation failed to load. Do not pretend: say so.
      BM.serviceMode = MODES.SIMULATED;
      BM.serviceModeFallback = true;
      console.error("[BuildMind] Remote services are unavailable; staying simulated.");
      return BM.serviceMode;
    }

    if (chosen === MODES.REMOTE) {
      BM.aiService = BM.remoteAIService;
      BM.projectService = BM.remoteProjectService;
      if (window.BM_CONFIG && window.BM_CONFIG.apiBaseUrl) {
        BM.api.configure({ baseUrl: window.BM_CONFIG.apiBaseUrl });
      }
      BM.serviceMode = MODES.REMOTE;
    } else {
      // Restore the implementations captured at load time. Assigning
      // `BM.localProjectService` here would be a bug: no such property exists.
      if (!LOCAL.ai || !LOCAL.projects) {
        throw new Error("[BuildMind] Simulated services were not captured at load");
      }
      BM.aiService = LOCAL.ai;
      BM.projectService = LOCAL.projects;
      BM.serviceMode = MODES.SIMULATED;
    }

    BM.serviceModeFallback = false;
    return BM.serviceMode;
  }

  Object.assign(BM, {
    SERVICE_MODES: MODES,
    requestedServiceMode: requested,
    installServices: install,
    serviceMode: null,
  });
})();
