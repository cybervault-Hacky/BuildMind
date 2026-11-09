/* ==========================================================================
   BuildMind — services/settings/localSettingsService.js
   The settings boundary: persisted preferences, motion and the two simulated
   connection flags.

   Public surface (contracts.js envelopes, never throws):

     loadSettings()                 → { settings, motion, connections, systemMotion }
     saveSettings(patch)            → { settings, motion, connections, systemMotion }
     resetSettings()                → { settings, motion, connections, systemMotion,
                                        reset: [which slices were restored] }
     loadPromptDraft() / savePromptDraft(prompt)
     getPersistedKeys()             → { keys }   (documentation + diagnostics)

   Deliberately absent from this service: any API-key writer. There is no
   method that can persist a secret, and `saveSettings` strips unknown keys,
   so a caller cannot smuggle one in.

   A future `remoteSettingsService` (per-account preferences) implements the
   same four methods; pages and store do not change.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, ERROR_TYPES, storage, STORAGE_KEYS } = BM;
  const catalog = BM.providerCatalog;

  const DEFAULTS = {
    provider: BM.DEFAULT_PROVIDER_ID,
    model: catalog.defaultModel(BM.DEFAULT_PROVIDER_ID),
    autoFix: true,
    hints: true,
  };

  const MODES = ["full", "reduced"];
  const ALLOWED = ["provider", "model", "autoFix", "hints"];
  const MAX_PROMPT = 600;

  /**
   * The scope of a reset, spelled out once so the controller, the UI copy and
   * the tests cannot drift. Projects and the prompt draft are deliberately
   * absent: neither is a setting, and reset must not touch user work.
   */
  const RESET_SCOPE = ["provider", "model", "preferences", "motion", "connections"];

  /** Coerce a stored/provider pair into something always valid. */
  function normalize(settings) {
    const input = settings || {};
    const provider = catalog.resolve(input.provider);
    const model = catalog.findModel(provider.id, input.model)
      ? input.model
      : catalog.defaultModel(provider.id);

    return {
      provider: provider.id,
      model,
      autoFix: input.autoFix !== false,
      hints: input.hints !== false,
    };
  }

  function readMotion() {
    const prefs = storage.readObject(STORAGE_KEYS.preferences, { motion: "full" });
    return MODES.indexOf(prefs.motion) === -1 ? "full" : prefs.motion;
  }

  function readConnections() {
    const conns = storage.readObject(STORAGE_KEYS.connections, {});
    return { roblox: conns.roblox === true, studio: conns.studio === true };
  }

  /**
   * The OS-level motion preference. Reported, never persisted: the user's own
   * choice stays the stored value, and this flag only lets the UI explain why
   * motion looks reduced even when "Full" is selected.
   */
  function readSystemMotion() {
    try {
      if (typeof window.matchMedia !== "function") return "unset";
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full";
    } catch (err) {
      return "unset";
    }
  }

  function loadSettings() {
    const settings = normalize(storage.readObject(STORAGE_KEYS.settings, DEFAULTS));
    return ok({
      settings,
      motion: readMotion(),
      connections: readConnections(),
      systemMotion: readSystemMotion(),
    });
  }

  function saveSettings(patch) {
    const input = patch || {};

    // Only known, non-sensitive keys are accepted.
    const accepted = {};
    ALLOWED.forEach((key) => {
      if (input[key] !== undefined) accepted[key] = input[key];
    });

    if (input.motion !== undefined && MODES.indexOf(input.motion) !== -1) {
      storage.write(STORAGE_KEYS.preferences, { motion: input.motion });
    }

    if (input.connections) {
      storage.write(STORAGE_KEYS.connections, {
        roblox: input.connections.roblox === true,
        studio: input.connections.studio === true,
      });
    }

    if (Object.keys(accepted).length) {
      const current = normalize(storage.readObject(STORAGE_KEYS.settings, DEFAULTS));
      storage.write(STORAGE_KEYS.settings, normalize({ ...current, ...accepted }));
    }

    return loadSettings();
  }

  /**
   * Restore every supported default. Projects (`buildmind.projects.v1`) and the
   * prompt draft (`buildmind.draft.v1`) are not settings and are never touched
   * here — a reset must not delete anyone's work.
   */
  function resetSettings() {
    storage.write(STORAGE_KEYS.settings, { ...DEFAULTS });
    storage.write(STORAGE_KEYS.preferences, { motion: "full" });
    storage.write(STORAGE_KEYS.connections, { roblox: false, studio: false });
    return ok({
      settings: { ...DEFAULTS },
      motion: "full",
      connections: readConnections(),
      systemMotion: readSystemMotion(),
      reset: RESET_SCOPE.slice(),
    });
  }

  function loadPromptDraft() {
    const draft = storage.readObject(STORAGE_KEYS.draft, { prompt: "" });
    const prompt = typeof draft.prompt === "string" ? draft.prompt.slice(0, MAX_PROMPT) : "";
    return ok({ prompt });
  }

  function savePromptDraft(prompt) {
    const text = String(prompt === undefined || prompt === null ? "" : prompt).slice(0, MAX_PROMPT);
    storage.write(STORAGE_KEYS.draft, { prompt: text });
    return ok({ prompt: text });
  }

  /** The audited list of keys this app may persist. No secret can appear. */
  function getPersistedKeys() {
    const used = storage.keys().filter((key) => Object.values(STORAGE_KEYS).indexOf(key) !== -1);
    return ok({ keys: used, all: Object.values(STORAGE_KEYS), sensitive: [] });
  }

  function clearAll() {
    Object.values(STORAGE_KEYS).forEach((key) => storage.remove(key));
    return ok(null);
  }

  BM.settingsService = createService("localSettingsService", {
    mode: "local",
    loadSettings,
    saveSettings,
    resetSettings,
    loadPromptDraft,
    savePromptDraft,
    getPersistedKeys,
    _defaults() {
      return { ...DEFAULTS };
    },
    _resetScope() {
      return RESET_SCOPE.slice();
    },
    _clearAll: clearAll,
    _fail(message) {
      // Exposed only so the error path can be exercised in tests.
      return BM.serviceFail(ERROR_TYPES.OPERATION, message);
    },
  });
})();
