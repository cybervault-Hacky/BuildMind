/* ==========================================================================
   BuildMind — services/ai/mockAIService.js
   The AI boundary. Today it is a simulation; tomorrow the same calls are
   answered by a real provider adapter.

   Public surface (all return the contracts.js envelope, and never throw):

     initialize()                              → { ready, mode, providers }
     getProviders()                            → providers
     getModels(providerId)                     → models
     validateConfiguration({provider,model,hasKey}) → { valid, errors }
     startBuild(request)                       → { runId, prompt, provider, model }
     stopBuild(runId)                          → { runId, stopped }
     subscribe(listener)                       → unsubscribe
     isAvailable()                             → boolean

   `startBuild` emits progress events through `subscribe`:

     { type: "start",  run  }
     { type: "stage",  run  }   stage advanced (index, id, label, status, progress)
     { type: "done",   run  }   finished — nothing was published anywhere
     { type: "error",  run, error }
     { type: "cancel", run  }

   The service holds no UI state. It knows a run only while it is working on
   it, and it forgets everything the moment the run ends. Replacing this file
   with `openaiAIService.js` (or a router) is the whole integration job: the
   store and the renderers do not change.

   Nothing here performs a network request, reads a key or invents a model
   response. Stages are timed, not generated.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES, BUILD_STAGES } = BM;
  const catalog = BM.providerCatalog;

  const MIN_PROMPT = 8;
  const MAX_PROMPT = 400;

  /** Active runs, keyed by runId. Runtime bookkeeping only — not UI state. */
  const runs = new Map();
  const listeners = new Set();
  let runCounter = 0;
  let initialized = false;

  function emit(event) {
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        // A broken listener must not break a run.
        console.error("[BuildMind] AI event listener failed", err);
      }
    });
  }

  function normalizeRequest(request) {
    const input = request || {};
    return {
      prompt: String(input.prompt || "").trim(),
      provider: input.provider || "",
      model: input.model || "",
      // Held in memory for the duration of the call and never used, stored or
      // logged. A real adapter would read it here.
      hasKey: Boolean(input.hasKey),
    };
  }

  /* ------------------------------------------------------------------------
     Provider metadata
     ------------------------------------------------------------------------ */
  function initialize() {
    initialized = true;
    return ok({ ready: true, mode: "mock", providers: catalog.list().length });
  }

  function getProviders() {
    return ok(catalog.list());
  }

  function getModels(providerId) {
    if (!catalog.find(providerId)) {
      return fail(ERROR_TYPES.CONFIGURATION, "That provider is no longer available.");
    }
    return ok(catalog.models(providerId));
  }

  function isAvailable() {
    return ok({ available: true, mode: "mock", initialized });
  }

  /* ------------------------------------------------------------------------
     Configuration validation — shape and presence only.
     The key is checked for presence, never verified against a provider.
     ------------------------------------------------------------------------ */
  function validateConfiguration(input) {
    const config = input || {};
    const errors = {};
    const prompt = String(config.prompt || "").trim();

    if (!prompt) errors.prompt = "Describe the game you want to build.";
    else if (prompt.length < MIN_PROMPT) errors.prompt = "A little more detail, at least a sentence.";
    else if (prompt.length > MAX_PROMPT) errors.prompt = "Shorter please — keep it under a paragraph.";

    const provider = catalog.find(config.provider);
    if (!provider) errors.provider = "Choose an AI provider.";
    else if (config.model && !catalog.findModel(provider.id, config.model)) {
      errors.model = "Choose a model for this provider.";
    }

    if (provider && provider.requiresKey && !config.hasKey) {
      errors.apiKey = "Enter a key to run a build. It is never stored or sent.";
    }

    const valid = Object.keys(errors).length === 0;
    return ok({ valid, errors, mode: "mock" });
  }

  /* ------------------------------------------------------------------------
     Runs
     ------------------------------------------------------------------------ */
  function finish(runId) {
    const run = runs.get(runId);
    if (!run) return;
    window.clearTimeout(run.timer);
    runs.delete(runId);
  }

  function startBuild(request) {
    const input = normalizeRequest(request);

    if (!input.prompt) {
      return fail(ERROR_TYPES.VALIDATION, "Describe the game you want to build.", {
        fields: { prompt: "Describe the game you want to build." },
      });
    }

    const provider = catalog.find(input.provider);
    if (!provider) {
      return fail(ERROR_TYPES.CONFIGURATION, "Choose an AI provider.");
    }

    const model = input.model || catalog.defaultModel(provider.id);
    if (!catalog.findModel(provider.id, model)) {
      return fail(ERROR_TYPES.CONFIGURATION, "Choose a model for this provider.");
    }

    runCounter += 1;
    const run = {
      runId: `run-${runCounter}`,
      prompt: input.prompt,
      provider: provider.id,
      model,
      startedAt: Date.now(),
      stage: -1,
      cancelled: false,
      done: false,
      timer: 0,
    };

    runs.set(run.runId, run);
    emit({ type: "start", run: publicRun(run) });

    // The first stage is emitted on the next tick, never synchronously, so a
    // caller that subscribes after `startBuild()` resolves still sees it.
    run.timer = window.setTimeout(() => advance(run), 0);

    return ok({ runId: run.runId, prompt: run.prompt, provider: run.provider, model: run.model });
  }

  function advance(run) {
    if (run.cancelled || run.done) return;

    run.stage += 1;
    const stage = BUILD_STAGES[run.stage];

    // All seven stages are reported, including the final "complete" one; the
    // store decides which state each stage maps to.
    emit({ type: "stage", run: publicRun(run) });

    if (run.stage >= BUILD_STAGES.length - 1) {
      run.done = true;
      finish(run.runId);
      emit({ type: "done", run: publicRun(run) });
      return;
    }

    run.timer = window.setTimeout(() => advance(run), stage.ms);
  }

  function stopBuild(runId) {
    const run = runs.get(runId);
    if (!run) {
      // Already finished or unknown: cancelling is a no-op, not an error.
      return ok({ runId: runId || null, stopped: false });
    }

    run.cancelled = true;
    finish(runId);
    emit({ type: "cancel", run: publicRun(run) });
    return ok({ runId, stopped: true });
  }

  function publicRun(run) {
    const stage = BUILD_STAGES[run.stage] || null;
    return {
      runId: run.runId,
      prompt: run.prompt,
      provider: run.provider,
      model: run.model,
      stageIndex: run.stage,
      stage: stage ? { ...stage } : null,
      stageCount: BUILD_STAGES.length,
      startedAt: run.startedAt,
    };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function activeRuns() {
    return Array.from(runs.keys());
  }

  BM.aiService = createService("mockAIService", {
    mode: "mock",
    initialize,
    getProviders,
    getModels,
    validateConfiguration,
    startBuild,
    stopBuild,
    subscribe,
    isAvailable,
    _activeRuns: activeRuns,
    _reset() {
      runs.forEach((run) => window.clearTimeout(run.timer));
      runs.clear();
      listeners.clear();
      runCounter = 0;
      initialized = false;
      return ok(null);
    },
  });
})();
