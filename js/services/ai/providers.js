/* ==========================================================================
   BuildMind — services/ai/providers.js
   The provider catalogue.

   One catalogue for the whole app, so the Build UI, the Settings UI and the
   validation rules can never disagree about which models exist.

   The list below is the *offline* catalogue: it is what the simulated mode
   uses, and it is the starting value in every mode. In `remote` mode the
   catalogue is replaced by the backend's own list (`setProviders`), because
   the backend is the authority on which providers and models exist — a
   client must not be able to offer a model the server does not have.

   Shape: { id, label, note, requiresKey, models: [{ id, label }] }
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  const OFFLINE_PROVIDERS = [
    {
      id: "openai",
      label: "OpenAI",
      note: "Requires your own key",
      requiresKey: true,
      models: [
        { id: "gpt-4.1", label: "GPT-4.1" },
        { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
        { id: "o4-mini", label: "o4-mini" },
      ],
    },
    {
      id: "google",
      label: "Google",
      note: "Requires your own key",
      requiresKey: true,
      models: [
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      ],
    },
  ];

  const DEFAULT_PROVIDER_ID = "openai";

  /** The live catalogue. Replaced wholesale when the backend answers. */
  let providers = OFFLINE_PROVIDERS.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  }));

  function list() {
    return providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
    }));
  }

  function find(id) {
    return providers.find((provider) => provider.id === id) || null;
  }

  /** Never throws: an unknown id falls back to the default provider. */
  function resolve(id) {
    return find(id) || find(DEFAULT_PROVIDER_ID) || providers[0] || null;
  }

  function models(providerId) {
    const provider = resolve(providerId);
    return provider ? provider.models.map((model) => ({ ...model })) : [];
  }

  function findModel(providerId, modelId) {
    const provider = resolve(providerId);
    if (!provider) return null;
    return provider.models.find((model) => model.id === modelId) || null;
  }

  /** First model of a provider — the value a provider switch cascades to. */
  function defaultModel(providerId) {
    const provider = resolve(providerId);
    return provider && provider.models[0] ? provider.models[0].id : "";
  }

  /**
   * Replace the catalogue with the backend's list.
   *
   * Only records that carry an id and at least one model are accepted: a
   * malformed entry must not empty the dropdown. The result is reported so
   * the caller can tell whether anything was adopted.
   */
  function setProviders(records) {
    if (!Array.isArray(records)) return { adopted: 0 };

    const next = records
      .filter((provider) => provider && typeof provider.id === "string" && provider.id)
      .map((provider) => ({
        id: provider.id,
        label: provider.label || provider.displayName || provider.id,
        note: provider.note || (provider.managedAvailable ? "BuildMind-managed" : "Your key"),
        // A provider BuildMind pays for needs no key from the user.
        requiresKey: provider.requiresKey !== false && !provider.managedAvailable,
        models: (provider.models || [])
          .filter((model) => model && typeof model.id === "string" && model.id)
          .map((model) => ({ id: model.id, label: model.label || model.displayName || model.id })),
      }))
      .filter((provider) => provider.models.length > 0);

    if (!next.length) return { adopted: 0 };
    providers = next;
    return { adopted: next.length };
  }

  /** Restore the offline catalogue. Used by the simulated mode and by tests. */
  function reset() {
    providers = OFFLINE_PROVIDERS.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
    }));
    return list();
  }

  Object.assign(BM, {
    PROVIDERS: OFFLINE_PROVIDERS,
    DEFAULT_PROVIDER_ID,
    providerCatalog: { list, find, resolve, models, findModel, defaultModel, setProviders, reset },
  });
})();
