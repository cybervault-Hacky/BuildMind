/* ==========================================================================
   BuildMind — services/ai/remoteAIService.js
   The backend-backed AI boundary.

   It implements the SAME public surface and the SAME event contract as
   mockAIService.js, so buildController.js and the Build renderer do not
   change:

     initialize()                              → { ready, mode, providers }
     getProviders() / getModels(providerId)
     validateConfiguration({provider,model,hasKey,prompt})
     startBuild(request)                       → { runId, prompt, provider, model }
     stopBuild(runId)                          → { runId, stopped }
     subscribe(listener)                       → unsubscribe
     isAvailable()

   Events are translated from the backend's SSE frames into the frontend's
   event vocabulary. Progress is the backend's real progress, not an
   interpolated one.

   Nothing here invents a stage. If the backend reports `testing`, the UI
   shows Testing because a real validation pass ran.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES, BUILD_STAGES } = BM;

  const STAGE_BY_ID = {};
  (BUILD_STAGES || []).forEach((stage, index) => {
    STAGE_BY_ID[stage.id] = index;
  });

  /** Backend status → the frontend build status vocabulary. */
  const STATUS_MAP = {
    queued: "building",
    preparing: "building",
    understanding: "building",
    planning: "building",
    building: "building",
    testing: "testing",
    fixing: "fixing",
    validating: "validating",
    complete: "complete",
    failed: "error",
    cancelled: "stopped",
  };

  const listeners = new Set();
  /** runId → { source, buildId, unsubscribers } */
  const runs = new Map();
  /** runId → { prompt, provider, model, buildId } */
  const requests = new Map();

  function emit(event) {
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        console.error("[BuildMind] AI event listener failed", err);
      }
    });
  }

  function initialize() {
    return BM.api.me().then((result) => {
      const authenticated = BM.isOk(result) && result.data && result.data.authenticated;
      if (!authenticated) {
        // Not an error: the UI simply shows the signed-out state.
        return ok({ ready: false, mode: "remote", providers: 0, authenticated: false });
      }
      return BM.api.listProviders().then((providers) => {
        const count = BM.isOk(providers) ? (providers.data.providers || []).length : 0;
        return ok({ ready: true, mode: "remote", providers: count, authenticated: true });
      });
    });
  }

  function isAvailable() {
    return ok({ available: true, mode: "remote", initialized: true });
  }

  function getProviders() {
    return BM.api.listProviders().then((result) => {
      if (!BM.isOk(result)) return result;
      // Adapt the backend's provider records to the frontend's catalog shape.
      const providers = (result.data.providers || []).map((provider) => ({
        id: provider.id,
        label: provider.displayName,
        note: provider.managedAvailable ? "BuildMind-managed" : "Your key",
        requiresKey: !provider.managedAvailable,
        models: (provider.models || []).map((m) => ({ id: m.id, label: m.displayName })),
      }));
      return ok(providers);
    });
  }

  function getModels(providerId) {
    return BM.api.listModels(providerId).then((result) => {
      if (!BM.isOk(result)) return result;
      return ok(
        (result.data.models || []).map((m) => ({
          id: m.id,
          label: m.displayName,
        })),
      );
    });
  }

  /**
   * Shape validation only — deliberately NOT a provider call.
   *
   * The rules say a provider must not be validated silently on every page
   * load and must not spend tokens unnecessarily. Real credential
   * verification is the explicit `verifyProvider()` call below, which the
   * Settings page triggers on a button press.
   */
  function validateConfiguration(input) {
    const config = input || {};
    const errors = {};
    const prompt = String(config.prompt || "").trim();

    if (!prompt) errors.prompt = "Describe the game you want to build.";
    else if (prompt.length < 8) errors.prompt = "A little more detail, at least a sentence.";
    else if (prompt.length > 400) errors.prompt = "Shorter please — keep it under a paragraph.";

    if (!config.provider) errors.provider = "Choose an AI provider.";
    if (!config.model) errors.model = "Choose a model for this provider.";
    if (!config.hasKey) errors.apiKey = "Enter a key to run a build.";

    const valid = Object.keys(errors).length === 0;
    return Promise.resolve(ok({ valid, errors, mode: "remote" }));
  }

  /** The real credential check. Only this may turn the UI to "Valid". */
  function verifyProvider(input) {
    const config = input || {};
    return BM.api.validateProvider({
      provider: config.provider,
      ...(config.model ? { model: config.model } : {}),
      // The key travels in the POST body, never in a URL.
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  /* ------------------------------------------------------------------------
     Build lifecycle
     ------------------------------------------------------------------------ */
  function startBuild(request) {
    const input = request || {};
    const buildRequest = {
      projectId: input.projectId,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    };

    return BM.api.createBuild(buildRequest).then((result) => {
      if (!BM.isOk(result)) return result;

      const build = result.data.build;
      const runId = build.runId;

      requests.set(runId, {
        buildId: build.id,
        prompt: input.prompt || "",
        provider: input.provider,
        model: input.model,
      });

      emit({
        type: "start",
        runId,
        run: {
          runId,
          buildId: build.id,
          prompt: input.prompt || "",
          provider: input.provider,
          model: input.model,
          plan: null,
        },
      });

      attachStream(build.id, runId);

      return ok({
        runId,
        buildId: build.id,
        prompt: input.prompt || "",
        provider: input.provider,
        model: input.model,
        plan: null,
      });
    });
  }

  /** Subscribe to the build's SSE stream and translate frames to events. */
  function attachStream(buildId, runId) {
    const record = { buildId, source: null, seen: 0 };
    runs.set(runId, record);

    if (typeof window.EventSource !== "function") {
      // No EventSource: fall back to polling so the build is still followed.
      record.source = "poll";
      pollEvents(buildId, runId, record);
      return;
    }

    let source;
    try {
      source = new window.EventSource(BM.api.buildStreamUrl(buildId, 0), { withCredentials: true });
    } catch {
      record.source = "poll";
      pollEvents(buildId, runId, record);
      return;
    }

    record.source = source;

    source.onmessage = (message) => {
      let frame;
      try {
        frame = JSON.parse(message.data);
      } catch {
        return;
      }
      if (frame.seq !== undefined) {
        if (frame.seq <= record.seen) return;
        record.seen = frame.seq;
      }
      translate(runId, frame);
    };

    source.onerror = () => {
      // A closed stream after a terminal frame is normal. Only report if the
      // run is still current and has not finished.
      if (!runs.has(runId)) return;
      closeStream(runId);
    };
  }

  /** Polling fallback: same translation, no EventSource. */
  function pollEvents(buildId, runId, record) {
    const tick = () => {
      if (!runs.has(runId)) return;

      BM.api.getBuildEvents(buildId, record.seen).then((result) => {
        if (!BM.isOk(result)) return;
        (result.data.events || []).forEach((event) => {
          if (event.seq <= record.seen) return;
          record.seen = event.seq;
          translate(runId, event);
        });
      });

      window.setTimeout(tick, 400);
    };
    tick();
  }

  /** One backend frame → one frontend event. */
  function translate(runId, frame) {
    if (!runs.has(runId)) return; // a stopped or superseded run
    const request = requests.get(runId) || {};

    if (frame.terminal === true || ["complete", "failed", "cancelled"].includes(frame.status)) {
      const status = STATUS_MAP[frame.status] || "error";
      const run = {
        runId,
        buildId: request.buildId,
        prompt: request.prompt,
        provider: request.provider,
        model: request.model,
      };

      if (status === "complete") {
        emit({ type: "done", runId, run: { ...run, status: "complete", progress: 100 } });
      } else if (status === "stopped") {
        emit({ type: "cancel", runId, run: { ...run, status: "stopped" } });
      } else {
        emit({
          type: "error",
          runId,
          error: { type: ERROR_TYPES.OPERATION, message: "The build did not complete.", code: frame.status },
        });
      }

      closeStream(runId);
      requests.delete(runId);
      return;
    }

    const stageIndex = frame.stage !== undefined && frame.stage !== null ? STAGE_BY_ID[frame.stage] : undefined;
    const status = STATUS_MAP[frame.status] || "building";

    emit({
      type: "stage",
      runId,
      stageIndex: stageIndex === undefined ? -1 : stageIndex,
      stageId: frame.stage || null,
      status,
      progress: typeof frame.progress === "number" ? frame.progress : 0,
      description: frame.activity || "",
      activity: frame.activity ? [frame.activity] : [],
    });
  }

  function closeStream(runId) {
    const record = runs.get(runId);
    if (!record) return;
    if (record.source && typeof record.source.close === "function") {
      try {
        record.source.close();
      } catch {
        // Already closed.
      }
    }
    runs.delete(runId);
  }

  function stopBuild(runId) {
    const record = runs.get(runId);
    const buildId = record ? record.buildId : requests.get(runId)?.buildId;

    closeStream(runId);
    requests.delete(runId);

    if (!buildId) {
      // Nothing to cancel on the backend; the UI still needs a settled answer.
      return Promise.resolve(ok({ runId, stopped: true }));
    }

    return BM.api.cancelBuild(buildId).then((result) => {
      if (!BM.isOk(result)) {
        // A build that already finished cannot be cancelled; report it as
        // "not stopped" rather than pretending the cancel worked.
        return ok({ runId, stopped: false });
      }
      return ok({ runId, stopped: true, build: result.data.build });
    });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const implementation = {
    mode: "remote",
    initialize,
    isAvailable,
    getProviders,
    getModels,
    validateConfiguration,
    verifyProvider,
    startBuild,
    stopBuild,
    subscribe,
    _reset() {
      runs.forEach((record) => closeStream(record.buildId));
      runs.clear();
      requests.clear();
      listeners.clear();
    },
  };

  BM.remoteAIService = createService("ai", implementation);
})();
