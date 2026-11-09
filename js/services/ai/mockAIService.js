/* ==========================================================================
   BuildMind — services/ai/mockAIService.js
   The AI boundary. Today it is a simulation; tomorrow the same calls are
   answered by a real provider adapter.

   Public surface (all return the contracts.js envelope, and never throw):

     initialize()                              → { ready, mode, providers }
     getProviders()                            → providers
     getModels(providerId)                     → models
     validateConfiguration({provider,model,hasKey,prompt}) → { valid, errors }
     startBuild(request)                       → { runId, prompt, provider, model, plan }
     stopBuild(runId)                          → { runId, stopped }
     subscribe(listener)                       → unsubscribe
     isAvailable()                             → boolean

   Event contract — every event carries the run it belongs to:

     { type: "start",    runId, run }
     { type: "stage",    runId, stageIndex, stageId, stageLabel, status,
                         progress, description, activity[] }
     { type: "progress", runId, stageIndex, progress }
     { type: "activity", runId, stageIndex, message, at }
     { type: "done",     runId, run }
     { type: "error",    runId, error }
     { type: "cancel",   runId, run }

   Consumers must match `runId` against their active run and ignore anything
   else — a cancelled run can keep emitting for one more tick internally.
   After `start` there is a short PREPARE_MS beat before the first `stage`, so
   the UI can show a "preparing" acknowledgement.

   The service holds no UI state. It knows a run only while it is working on
   it and forgets it the moment the run ends. Replacing this file with
   `openaiAIService.js` (or a router) is the whole integration job: the store
   and the renderers do not change.

   Nothing here performs a network request, reads a key or invents a model
   response. Progress is interpolated between stage targets so the bar moves
   smoothly, and every activity line describes an internal planning step —
   never a real compilation, upload or deployment.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES, BUILD_STAGES, STAGE_INDEX } = BM;
  const catalog = BM.providerCatalog;

  const MIN_PROMPT = 8;
  const MAX_PROMPT = 400;

  /** How often progress interpolates towards the next stage target. */
  const TICK_MS = 120;

  /**
   * Deliberate beat between accepting the request and reporting the first
   * stage, so the UI can acknowledge the click ("Preparing build") instead of
   * jumping straight from idle to stage one.
   */
  const PREPARE_MS = 420;

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
     Run planning

     Each run gets a deterministic plan derived from the prompt, so the same
     idea behaves the same way and nothing is random per render. Some runs
     take the short path (test → validate) and some loop through fixing.
     ------------------------------------------------------------------------ */
  function hashPrompt(prompt) {
    let hash = 0;
    for (let i = 0; i < prompt.length; i += 1) {
      hash = (hash * 31 + prompt.charCodeAt(i)) % 1000003;
    }
    return hash;
  }

  function planFor(prompt) {
    const hash = hashPrompt(prompt);
    // Roughly two runs in three loop through the fixing stage; the rest go
    // straight from testing to validation.
    const needsFix = hash % 3 !== 0;

    const sequence = ["understand", "plan", "build", "test"];
    if (needsFix) sequence.push("fix", "test");
    sequence.push("validate");

    return {
      sequence,
      needsFix,
      // Small pace variation stops repeated runs from feeling scripted.
      pace: 0.9 + ((hash >> 3) % 5) * 0.05,
    };
  }

  /* ------------------------------------------------------------------------
     Runs
     ------------------------------------------------------------------------ */
  function stopTimers(run) {
    window.clearTimeout(run.stageTimer);
    window.clearInterval(run.tickTimer);
    run.stageTimer = 0;
    run.tickTimer = 0;
  }

  function finish(runId) {
    const run = runs.get(runId);
    if (!run) return;
    stopTimers(run);
    runs.delete(runId);
  }

  function startBuild(request) {
    const input = normalizeRequest(request);

    // A service-level backstop: one simulated run at a time, whatever the
    // caller does. Duplicate clicks can never stack runs.
    if (runs.size > 0) {
      return fail(ERROR_TYPES.OPERATION, "A build is already running.", { duplicate: true });
    }

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
    const plan = planFor(input.prompt);
    const run = {
      runId: `run-${runCounter}`,
      prompt: input.prompt,
      provider: provider.id,
      model,
      startedAt: Date.now(),
      plan,
      sequenceIndex: -1,
      stageIndex: -1,
      activityIndex: -1,
      progress: 0,
      cancelled: false,
      done: false,
      stageTimer: 0,
      tickTimer: 0,
    };

    runs.set(run.runId, run);
    emit({ type: "start", runId: run.runId, run: publicRun(run) });

    // The first stage is emitted after a short preparation beat, never
    // synchronously, so a caller that subscribes after `startBuild()` resolves
    // still sees every event.
    run.stageTimer = window.setTimeout(() => advance(run), PREPARE_MS);

    return ok({ runId: run.runId, prompt: run.prompt, provider: run.provider, model: run.model, plan });
  }

  /** Move to the next stage in this run's own sequence. */
  function advance(run) {
    if (run.cancelled || run.done) return;

    run.sequenceIndex += 1;
    const stageId = run.plan.sequence[run.sequenceIndex];

    if (!stageId) {
      run.done = true;
      finish(run.runId);
      emit({ type: "done", runId: run.runId, run: publicRun(run) });
      return;
    }

    const stageIndex = STAGE_INDEX[stageId];
    const stage = BUILD_STAGES[stageIndex];

    run.stageIndex = stageIndex;
    run.activityIndex = -1;
    startInterpolation(run, stage);

    emit({
      type: "stage",
      runId: run.runId,
      stageIndex,
      stageId,
      stageLabel: stage.label,
      description: stage.description,
      status: stage.status,
      progress: Math.max(stage.progress, run.progress),
      activity: stage.activity.slice(),
    });

    run.stageTimer = window.setTimeout(() => advance(run), Math.round(stage.ms * run.plan.pace));
  }

  /**
   * Walk progress towards the stage target in small steps so the bar never
   * jumps. Activity lines are released on the same tick as progress moves.
   */
  function startInterpolation(run, stage) {
    window.clearInterval(run.tickTimer);

    const from = run.progress;
    // A repeat visit to a stage must not pull the bar backwards.
    const to = Math.max(stage.progress, run.progress);
    const duration = Math.max(240, Math.round(stage.ms * run.plan.pace));
    const startedAt = Date.now();
    const activityCount = stage.activity.length;

    run.tickTimer = window.setInterval(() => {
      if (run.cancelled || run.done) {
        window.clearInterval(run.tickTimer);
        return;
      }

      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(1, elapsed / duration);
      // Ease-out so the final approach settles rather than snapping.
      const eased = 1 - Math.pow(1 - ratio, 2);
      const next = from + (to - from) * eased;

      if (next > run.progress) {
        run.progress = Math.min(to, next);
        emit({ type: "progress", runId: run.runId, stageIndex: run.stageIndex, progress: run.progress });
      }

      // Release activity lines evenly across the stage.
      const due = Math.min(activityCount, Math.floor(ratio * activityCount));
      while (run.activityIndex + 1 < due) {
        run.activityIndex += 1;
        emit({
          type: "activity",
          runId: run.runId,
          stageIndex: run.stageIndex,
          message: stage.activity[run.activityIndex],
          at: Date.now(),
        });
      }

      if (ratio >= 1) {
        window.clearInterval(run.tickTimer);
        run.tickTimer = 0;
      }
    }, TICK_MS);
  }

  function stopBuild(runId) {
    const run = runs.get(runId);
    if (!run) {
      // Already finished or unknown: cancelling is a no-op, not an error.
      return ok({ runId: runId || null, stopped: false });
    }

    run.cancelled = true;
    finish(runId);
    emit({ type: "cancel", runId: run.runId, run: publicRun(run) });
    return ok({ runId, stopped: true });
  }

  /** Simulated failure — the UI and tests use this to prove recovery. */
  function failBuild(runId, message) {
    const run = runs.get(runId);
    if (!run) return ok({ runId: runId || null, failed: false });

    stopTimers(run);
    runs.delete(runId);
    emit({
      type: "error",
      runId: run.runId,
      error: { type: ERROR_TYPES.OPERATION, message: message || "The simulated run stopped unexpectedly." },
      run: publicRun(run),
    });
    return ok({ runId, failed: true });
  }

  function publicRun(run) {
    const stage = BUILD_STAGES[run.stageIndex] || null;
    return {
      runId: run.runId,
      prompt: run.prompt,
      provider: run.provider,
      model: run.model,
      stageIndex: run.stageIndex,
      stage: stage ? { ...stage, activity: stage.activity.slice() } : null,
      stageCount: BUILD_STAGES.length,
      progress: run.progress,
      needsFix: run.plan.needsFix,
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

  /** The plan a run will follow — exposed so tests can assert both paths. */
  function planForPrompt(prompt) {
    return ok(planFor(String(prompt || "")));
  }

  BM.aiService = createService("mockAIService", {
    mode: "mock",
    initialize,
    getProviders,
    getModels,
    validateConfiguration,
    startBuild,
    stopBuild,
    failBuild,
    subscribe,
    isAvailable,
    planForPrompt,
    _activeRuns: activeRuns,
    _reset() {
      runs.forEach((run) => stopTimers(run));
      runs.clear();
      listeners.clear();
      runCounter = 0;
      initialized = false;
      return ok(null);
    },
  });
})();
