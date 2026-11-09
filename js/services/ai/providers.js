/* ==========================================================================
   BuildMind — services/ai/providers.js
   The single source of truth for AI providers and their models.

   Nothing else in the app may define a provider or model list. Build UI,
   Settings UI and validation all read from here, which is why adding a
   provider means editing this file only:

     { id, label, note, requiresKey, models: [{ id, label }] }

   These are configuration records, not integrations. No provider below is
   contacted in any way; Phase 4 ships a mock implementation behind them.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  const PROVIDERS = [
    {
      id: "openai",
      label: "OpenAI",
      note: "Simulated provider",
      requiresKey: true,
      models: [
        { id: "gpt-4.1", label: "GPT-4.1" },
        { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
        { id: "o4-mini", label: "o4-mini" },
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      note: "Simulated provider",
      requiresKey: true,
      models: [
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ],
    },
    {
      id: "google",
      label: "Google",
      note: "Simulated provider",
      requiresKey: true,
      models: [
        { id: "gemini-2-5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2-5-flash", label: "Gemini 2.5 Flash" },
      ],
    },
    {
      id: "xai",
      label: "xAI",
      note: "Simulated provider",
      requiresKey: true,
      models: [{ id: "grok-4", label: "Grok 4" }],
    },
  ];

  const DEFAULT_PROVIDER_ID = "openai";

  function list() {
    return PROVIDERS.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
    }));
  }

  function find(id) {
    return PROVIDERS.find((provider) => provider.id === id) || null;
  }

  /** Never throws: an unknown id falls back to the default provider. */
  function resolve(id) {
    return find(id) || find(DEFAULT_PROVIDER_ID) || PROVIDERS[0];
  }

  function models(providerId) {
    const provider = resolve(providerId);
    return provider.models.map((model) => ({ ...model }));
  }

  function findModel(providerId, modelId) {
    const provider = resolve(providerId);
    return provider.models.find((model) => model.id === modelId) || null;
  }

  /** First model of a provider — the value a provider switch cascades to. */
  function defaultModel(providerId) {
    const provider = resolve(providerId);
    return provider.models[0] ? provider.models[0].id : "";
  }

  Object.assign(BM, {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    providerCatalog: { list, find, resolve, models, findModel, defaultModel },
  });
})();
