/* ==========================================================================
   BuildMind — controllers/settingsController.js
   The single settings path: load, change, save, reset.

   Provider and model changes are validated against the provider catalogue
   before they reach state, so a model can never belong to the wrong provider.
   All persistence goes through settingsService; this file never touches the
   browser's storage and never sees an API key.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES } = BM;
  const catalog = BM.providerCatalog;

  let loaded = false;

  /** Load persisted settings into state. Safe to call more than once. */
  function load() {
    return BM.settingsService.loadSettings().then((result) => {
      if (!BM.isOk(result)) return result;

      const { settings, motion, connections } = result.data;
      BM.applySettings(settings);
      BM.applyMotion(motion);
      BM.setConnectionStatus("roblox", connections.roblox ? "connected" : "disconnected");
      BM.setConnectionStatus("studio", connections.studio ? "connected" : "disconnected");
      loaded = true;
      return result;
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

  /** Provider switch: the model cascades to that provider's first model. */
  function setProvider(id) {
    const provider = catalog.find(id);
    if (!provider) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That provider is unavailable."));
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

  function reset() {
    return BM.settingsService.resetSettings().then((result) => {
      if (!BM.isOk(result)) return result;

      const { settings, motion } = result.data;
      BM.applySettings(settings);
      BM.applyMotion(motion);
      BM.setApiKeyPresent(false);
      return result;
    });
  }

  /** The catalogue is the only provider source; expose it read-only. */
  function getProviders() {
    return catalog.list();
  }

  function getModels(providerId) {
    return catalog.models(providerId || BM.getState().settings.provider);
  }

  function getProvider(id) {
    return catalog.resolve(id);
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
    getProviders,
    getModels,
    getProvider,
    persisted,
    failExample() {
      return BM.serviceFail(ERROR_TYPES.OPERATION, "Settings could not be saved.");
    },
  };
})();
