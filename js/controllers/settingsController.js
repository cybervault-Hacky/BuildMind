/* ==========================================================================
   BuildMind — controllers/settingsController.js
   The single settings path: load, change, save, reset.

   Provider and model changes are validated against the provider catalogue
   before they reach state, so a model can never belong to the wrong provider.
   All persistence goes through settingsService; this file never touches the
   browser's storage and never sees an API key — it only knows whether one has
   been supplied for this session, because that is what the configuration
   status needs.

   `describeConfiguration()` is the one place that decides whether the current
   configuration is "not configured", "incomplete" or "ready". It is derived
   from real state every time it is called, so the Settings page and the Build
   page cannot disagree, and no status is ever stored.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES } = BM;
  const catalog = BM.providerCatalog;

  let loaded = false;

  /* ------------------------------------------------------------------------
     Load
     ------------------------------------------------------------------------ */
  function applyLoaded(result) {
    const { settings, motion, connections } = result.data;
    BM.applySettings(settings);
    BM.applyMotion(motion);
    BM.setConnectionStatus("roblox", connections.roblox ? "connected" : "disconnected");
    BM.setConnectionStatus("studio", connections.studio ? "connected" : "disconnected");
    loaded = true;
    return result;
  }

  /** Load persisted settings into state. Safe to call more than once. */
  function load() {
    return BM.settingsService.loadSettings().then((result) => {
      if (!BM.isOk(result)) return result;
      return applyLoaded(result);
    });
  }

  function isLoaded() {
    return loaded;
  }

  function save(patch) {
    return BM.settingsService.saveSettings(patch).then((result) => {
      if (BM.isOk(result)) loaded = true;
      return result;
    });
  }

  /* ------------------------------------------------------------------------
     Provider / model
     ------------------------------------------------------------------------ */

  /**
   * Switch provider. The model cascades to that provider's first model in the
   * same write, so an invalid provider/model pair can never exist, not even
   * for a frame.
   */
  function setProvider(id) {
    const provider = catalog.find(id);
    if (!provider) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That provider is unavailable."));
    }

    if (!provider.models.length) {
      return Promise.resolve(
        BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That provider has no models available.")
      );
    }

    const model = catalog.defaultModel(provider.id);
    BM.applySettings({ provider: provider.id, model });
    return save({ provider: provider.id, model });
  }

  function setModel(id) {
    const { provider } = BM.getState().settings;
    if (!catalog.findModel(provider, id)) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That model is not available."));
    }

    BM.applySettings({ model: id });
    return save({ model: id });
  }

  /* ------------------------------------------------------------------------
     Preferences
     ------------------------------------------------------------------------ */
  function setPreference(key, value) {
    if (key !== "autoFix" && key !== "hints") {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.VALIDATION, "Unknown preference."));
    }

    BM.applySettings({ [key]: Boolean(value) });
    return save({ [key]: Boolean(value) });
  }

  function setMotion(mode) {
    const next = mode === "reduced" ? "reduced" : "full";
    BM.applyMotion(next);
    return save({ motion: next });
  }

  /* ------------------------------------------------------------------------
     Reset — one coherent update, and only for settings
     ------------------------------------------------------------------------ */
  function reset() {
    return BM.settingsService.resetSettings().then((result) => {
      if (!BM.isOk(result)) return result;

      const { settings, motion, connections } = result.data;
      BM.applySettings(settings);
      BM.applyMotion(motion);
      // A reset ends the simulated connections too, which is what the UI said
      // it would do. The services are told so their own status matches.
      ["roblox", "studio"].forEach((target) => {
        const next = connections[target] ? "connected" : "disconnected";
        BM.setConnectionStatus(target, next);
        if (!connections[target]) BM.connectionController?.disconnect?.(target);
      });
      // The key was never persisted, so there is nothing to restore — but a
      // reset should also not leave a stale "key present" flag behind.
      BM.setApiKeyPresent(false);
      return result;
    });
  }

  /** What a reset changes, for the confirmation copy and the tests. */
  function resetScope() {
    return BM.settingsService._resetScope();
  }

  /* ------------------------------------------------------------------------
     Catalogue reads
     ------------------------------------------------------------------------ */
  function getProviders() {
    return catalog.list();
  }

  function getModels(providerId) {
    return catalog.models(providerId || BM.getState().settings.provider);
  }

  function getProvider(id) {
    return catalog.resolve(id);
  }

  /* ------------------------------------------------------------------------
     Configuration status — derived, never stored
     ------------------------------------------------------------------------ */

  /**
   * @param {object} [view] a state snapshot; the live one is used by default
   * @returns {{ id: string, label: string, tone: string, note: string,
   *             provider: object|null, model: object|null, needsKey: boolean,
   *             keyPresent: boolean }}
   */
  function describeConfiguration(view) {
    const current = view || BM.getState();
    const { settings, apiKeyPresent } = current;
    const provider = catalog.find(settings.provider) || null;
    const model = provider ? catalog.findModel(provider.id, settings.model) : null;
    const needsKey = Boolean(provider && provider.requiresKey);
    const keyPresent = Boolean(apiKeyPresent);

    if (!provider) {
      return {
        id: "unconfigured",
        label: "Not configured",
        tone: "idle",
        note: "Choose a provider to configure a build.",
        provider: null,
        model: null,
        needsKey: false,
        keyPresent,
      };
    }

    if (!model) {
      return {
        id: "incomplete",
        label: "Incomplete",
        tone: "warn",
        note: `Pick a model for ${provider.label}.`,
        provider,
        model: null,
        needsKey,
        keyPresent,
      };
    }

    if (needsKey && !keyPresent) {
      return {
        id: "incomplete",
        label: "Incomplete",
        tone: "warn",
        note: `Enter an API key for ${provider.label}. It is used for this session only.`,
        provider,
        model,
        needsKey,
        keyPresent,
      };
    }

    return {
      id: "ready",
      label: "Ready",
      tone: "ready",
      note: `${provider.label} · ${model.label}`,
      provider,
      model,
      needsKey,
      keyPresent,
    };
  }

  /**
   * Local shape checks only. There is no provider call anywhere in this app, so
   * nothing here can claim a key works — the wording says "entered", not
   * "verified".
   */
  function describeKeyState(value) {
    const text = String(value === undefined || value === null ? "" : value);

    if (!text.length) {
      return { id: "empty", message: "", present: false, invalid: false };
    }

    if (!text.trim().length) {
      return {
        id: "blank",
        message: "That is only whitespace. Paste the key itself.",
        present: false,
        invalid: true,
      };
    }

    return { id: "present", message: "", present: true, invalid: false };
  }

  function persisted() {
    return BM.settingsService.getPersistedKeys();
  }

  BM.settingsController = {
    mode: "local",
    load,
    isLoaded,
    save,
    setProvider,
    setModel,
    setPreference,
    setMotion,
    reset,
    resetScope,
    getProviders,
    getModels,
    getProvider,
    describeConfiguration,
    describeKeyState,
    persisted,
    failExample() {
      return BM.serviceFail(ERROR_TYPES.OPERATION, "Settings could not be saved.");
    },
  };
})();
