/* ==========================================================================
   BuildMind — controllers/settingsController.js
   The single settings path: load, change, save, reset, validate.

   Provider and model changes are validated against the provider catalogue
   before they reach state, so a model can never belong to the wrong provider.
   In `remote` mode that catalogue is the backend's own list, refreshed from
   `/ai/providers`, so the UI can never offer a model the server does not
   have.

   Provider *validation* is a separate, explicit action. The frontend never
   decides that a key works: it asks the backend, and it reports exactly what
   the backend answered — not configured, valid, invalid or unavailable.

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

  const { ERROR_TYPES, PROVIDER_VALIDATION } = BM;
  const catalog = BM.providerCatalog;

  let loaded = false;

  /* ------------------------------------------------------------------------
     Load
     ------------------------------------------------------------------------ */
  function applyLoaded(result) {
    const { settings, motion, connections } = result.data;
    const resolvedProvider = catalog.resolve(settings && settings.provider);
    const providerId = resolvedProvider ? resolvedProvider.id : (settings && settings.provider) || "";
    const modelObj = providerId ? catalog.findModel(providerId, settings && settings.model) : null;
    const modelId = modelObj ? modelObj.id : providerId ? catalog.defaultModel(providerId) : "";

    BM.applySettings({
      ...settings,
      ...(providerId ? { provider: providerId } : {}),
      ...(modelId ? { model: modelId } : {}),
    });
    BM.applyMotion(motion);
    if (!isRemote()) {
      BM.setConnectionStatus("roblox", connections.roblox ? "connected" : "disconnected");
      BM.setConnectionStatus("studio", connections.studio ? "connected" : "disconnected");
    }
    loaded = true;
    return result;
  }

  /**
   * Load persisted settings into state.
   *
   * In remote mode the provider catalogue is also refreshed from the backend
   * once authenticated, because the backend is the authority on which
   * providers and models exist.
   */
  function load(options) {
    const opts = options || {};
    const settings = BM.settingsService.loadSettings();

    if (!isRemote() || !BM.isAuthenticated() || opts.skipProviders) {
      return settings.then((result) => {
        if (!BM.isOk(result)) return result;
        return applyLoaded(result);
      });
    }

    return Promise.all([settings, BM.aiService.getProviders()]).then(([result]) => {
      if (!BM.isOk(result)) return result;
      return applyLoaded(result);
    });
  }

  function isRemote() {
    return BM.serviceMode === BM.SERVICE_MODES.REMOTE;
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
    // A different provider means the previous validation no longer applies.
    BM.setProviderValidation({
      status: PROVIDER_VALIDATION.NOT_CONFIGURED,
      detail: "",
      provider: provider.id,
      model,
      checkedAt: 0,
    });
    return save({ provider: provider.id, model });
  }

  function setModel(id) {
    const { provider } = BM.getState().settings;
    if (!catalog.findModel(provider, id)) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.CONFIGURATION, "That model is not available."));
    }

    BM.applySettings({ model: id });
    BM.setProviderValidation({
      status: PROVIDER_VALIDATION.NOT_CONFIGURED,
      detail: "",
      provider,
      model: id,
      checkedAt: 0,
    });
    return save({ model: id });
  }

  /* ------------------------------------------------------------------------
     Provider validation — the backend decides
     ------------------------------------------------------------------------ */

  /**
   * Check a provider credential against the real provider.
   *
   * The result is one of:
   *   not_configured | valid | invalid | unavailable
   *
   * A key is never "valid" because the field was not empty: only the
   * backend's answer can move the status to `valid`.
   */
  function verifyProvider(input) {
    const config = input || {};
    const { settings } = BM.getState();
    const provider = config.provider || settings.provider;
    const model = config.model || settings.model;

    if (!provider) {
      BM.setProviderValidation({
        status: PROVIDER_VALIDATION.NOT_CONFIGURED,
        detail: "Choose a provider first.",
        provider: "",
        model: "",
        checkedAt: Date.now(),
      });
      return Promise.resolve(
        BM.serviceFail(ERROR_TYPES.CONFIGURATION, "Choose a provider first.")
      );
    }

    const service = BM.aiService;
    if (typeof service.verifyProvider !== "function") {
      // The simulated service has no provider to talk to. Say so instead of
      // pretending the key was checked.
      BM.setProviderValidation({
        status: PROVIDER_VALIDATION.NOT_CONFIGURED,
        detail: "Provider checks need the BuildMind API.",
        provider,
        model,
        checkedAt: Date.now(),
      });
      return Promise.resolve(
        BM.serviceFail(ERROR_TYPES.CONFIGURATION, "Provider checks need the BuildMind API.")
      );
    }

    BM.setProviderValidation({
      status: PROVIDER_VALIDATION.CHECKING,
      detail: "",
      provider,
      model,
      checkedAt: 0,
    });

    return service
      .verifyProvider({
        provider,
        ...(model ? { model } : {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      })
      .then((result) => {
        if (!BM.isOk(result)) {
          const status =
            result.error && result.error.code === "PROVIDER_UNAVAILABLE"
              ? PROVIDER_VALIDATION.UNAVAILABLE
              : PROVIDER_VALIDATION.INVALID;
          BM.setProviderValidation({
            status,
            detail: (result.error && result.error.message) || "",
            provider,
            model,
            checkedAt: Date.now(),
          });
          return result;
        }

        const data = result.data || {};
        const status =
          data.status === "valid"
            ? PROVIDER_VALIDATION.VALID
            : data.status === "unavailable"
            ? PROVIDER_VALIDATION.UNAVAILABLE
            : data.status === "not_configured"
            ? PROVIDER_VALIDATION.NOT_CONFIGURED
            : PROVIDER_VALIDATION.INVALID;

        BM.setProviderValidation({
          status,
          detail: data.detail || "",
          provider,
          model,
          checkedAt: Date.now(),
        });

        return BM.serviceOk({
          status,
          valid: status === PROVIDER_VALIDATION.VALID,
          detail: data.detail || "",
        });
      });
  }

  /** The current validation state, for the UI. */
  function providerValidation() {
    return { ...BM.getState().providerValidation };
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
      // A reset ends the connections too, which is what the UI said it
      // would do. The services are told so their own status matches.
      ["roblox", "studio"].forEach((target) => {
        const next = connections[target] ? "connected" : "disconnected";
        BM.setConnectionStatus(target, next);
        if (!connections[target]) BM.connectionController?.disconnect?.(target);
      });
      // The key was never persisted, so there is nothing to restore — but a
      // reset should also not leave a stale "key present" flag or stored
      // session credential behind.
      BM.aiService?.forgetCredentials?.();
      BM.setApiKeyPresent(false);
      BM.setProviderValidation({
        status: PROVIDER_VALIDATION.NOT_CONFIGURED,
        detail: "",
        provider: settings.provider,
        model: settings.model,
        checkedAt: 0,
      });
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
    const keyPresent = Boolean(apiKeyPresent) || hasStoredKey(provider);

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

  /** True when the backend already holds a credential for this provider. */
  function hasStoredKey(provider) {
    if (!provider) return false;
    const service = BM.aiService;
    if (service && typeof service.hasStoredCredential === "function") {
      return Boolean(service.hasStoredCredential(provider.id));
    }
    return false;
  }

  /**
   * Local shape checks only. There is no provider call anywhere in this
   * function, so nothing here can claim a key works — the wording says
   * "entered", not "verified".
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
    mode: "remote",
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
    verifyProvider,
    providerValidation,
    persisted,
    failExample() {
      return BM.serviceFail(ERROR_TYPES.OPERATION, "Settings could not be saved.");
    },
  };
})();
