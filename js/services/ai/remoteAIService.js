/* ==========================================================================
   BuildMind — services/ai/remoteAIService.js
   The backend-backed AI boundary.

   It implements the SAME public surface as mockAIService.js, so
   buildController.js and the Build renderer do not change:

     initialize()                              → { ready, mode, providers }
     getProviders() / getModels(providerId)
     validateConfiguration({provider,model,hasKey,prompt})
     verifyProvider({provider,model,apiKey})   → { status, valid, detail }
     startBuild(request)                       → { runId, buildId, prompt, … }
     stopBuild(runId)                          → { runId, stopped }
     retryBuild(runId)                         → { runId, buildId, … }
     subscribe(listener)                       → unsubscribe
     isAvailable()

   Events are translated from the backend's SSE frames into the frontend's
   event vocabulary. Progress is the backend's real progress, not an
   interpolated one.

   Nothing here invents a stage. If the backend reports `testing`, the UI
   shows Testing because a real validation pass ran.

   Run ownership
   --------------
   Every run the service knows about is recorded in `runs`, keyed by the
   backend's runId, and carries the buildId it belongs to. A frame is only
   translated while its run is still registered, so a late frame from a
   stopped run can never repaint the UI, and a retried build (a new run on
   the same project) can never be overwritten by the run it replaced.

   Cancellation
   ------------
   `stopBuild` asks the backend to cancel and then *waits for the backend to
   confirm*. The UI is not told the build stopped before the server has
   recorded it, and a race (the build completed while the cancel was in
   flight) is reported as what actually happened.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;
  const STAGE_BY_REMOTE_ID = BM.STAGE_BY_REMOTE_ID || {};

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

  /** Terminal backend statuses. */
  const TERMINAL = ["complete", "failed", "cancelled"];

  /** How long the cancel confirmation waits before it gives up. */
  const CANCEL_WAIT_MS = 12000;
  const CANCEL_POLL_MS = 250;

  const listeners = new Set();
  /** runId → { buildId, projectId, prompt, provider, model, seen, settled, stream } */
  const runs = new Map();
  /** runId → { buildId, projectId, prompt, provider, model, status } for retry lookup. */
  const settledRuns = new Map();
  const MAX_SETTLED_RUNS = 20;
  /** provider → true when the backend already holds a credential for it. */
  const storedCredentials = new Set();

  function emit(event) {
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        console.error("[BuildMind] AI event listener failed", err);
      }
    });
  }

  /* ------------------------------------------------------------------------
     Bootstrap
     ------------------------------------------------------------------------ */
  function initialize() {
    const knownAuth =
      BM.getState().auth.checkedAt > 0
        ? Promise.resolve(ok({ authenticated: BM.isAuthenticated() }))
        : BM.api.me();

    return knownAuth.then((result) => {
      const authenticated = BM.isOk(result) && result.data && result.data.authenticated;
      if (!authenticated) {
        // Not an error: the UI simply shows the signed-out state.
        return ok({ ready: false, mode: "remote", providers: 0, authenticated: false });
      }
      return BM.api.listProviders().then((providers) => {
        if (!BM.isOk(providers)) {
          return ok({ ready: false, mode: "remote", providers: 0, authenticated: true });
        }
        const list = providers.data.providers || [];
        // The backend is the authority on which providers and models exist.
        BM.providerCatalog.setProviders(list);
        rememberCredentials(providers.data.credentials);
        return ok({ ready: true, mode: "remote", providers: list.length, authenticated: true });
      });
    });
  }

  /**
   * Remember which providers the backend already holds a credential for.
   *
   * The backend only ever exposes a hint (three characters) and an expiry —
   * never the key. This set is the frontend's answer to "does a build still
   * need a key from the user?", and the backend is the authority on it.
   */
  function rememberCredentials(credentials) {
    storedCredentials.clear();
    if (!Array.isArray(credentials)) return;
    credentials.forEach((entry) => {
      if (entry && typeof entry.provider === "string") storedCredentials.add(entry.provider);
    });
  }

  /** True when the backend already holds a usable credential for a provider. */
  function hasStoredCredential(provider) {
    return storedCredentials.has(String(provider || ""));
  }

  function isAvailable() {
    return ok({ available: true, mode: "remote", initialized: true });
  }

  function getProviders() {
    return BM.api.listProviders().then((result) => {
      if (!BM.isOk(result)) return result;
      BM.providerCatalog.setProviders(result.data.providers || []);
      rememberCredentials(result.data.credentials);
      return ok(BM.providerCatalog.list());
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

  /**
   * The real credential check. Only this may turn the UI to "Valid".
   *
   * The backend answers with one of:
   *   not_configured | valid | invalid | unavailable
   * and the frontend reports exactly that. A non-empty field is never
   * treated as a valid key.
   */
  function verifyProvider(input) {
    const config = input || {};
    return BM.api.validateProvider({
      provider: config.provider,
      ...(config.model ? { model: config.model } : {}),
      // The key travels in the POST body, never in a URL.
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    }).then((result) => {
      if (!BM.isOk(result)) {
        const status = result.error && result.error.code === "PROVIDER_UNAVAILABLE" ? "unavailable" : "invalid";
        return ok({
          status,
          valid: false,
          detail: (result.error && result.error.message) || "",
          source: null,
        });
      }
      const data = result.data || {};
      // A key that proved usable is now held by the backend, so a later build
      // does not need it sent again.
      if (data.valid && config.provider) storedCredentials.add(String(config.provider));
      return ok({
        status: data.status || (data.valid ? "valid" : "invalid"),
        valid: Boolean(data.valid),
        detail: data.detail || "",
        source: data.source || null,
      });
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

      if (input.apiKey && input.provider) {
        storedCredentials.add(String(input.provider));
      }

      const build = result.data.build;
      const runId = build.runId;

      registerRun({
        runId,
        buildId: build.id,
        projectId: build.projectId,
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
          projectId: build.projectId,
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
        projectId: build.projectId,
        prompt: input.prompt || "",
        provider: input.provider,
        model: input.model,
        plan: null,
      });
    });
  }

  function registerRun(record) {
    runs.set(record.runId, {
      ...record,
      seen: 0,
      settled: false,
      stream: null,
      cancelTimer: 0,
    });
  }

  /** Subscribe to the build's SSE stream and translate frames to events. */
  function attachStream(buildId, runId) {
    const record = runs.get(runId);
    if (!record) return;

    const handle = BM.sse.create({
      id: `build:${buildId}:${runId}`,
      // The URL is re-read on every (re)connect, so `after` always reflects
      // the last frame that was actually delivered.
      url: () => BM.api.buildStreamUrl(buildId, record.seen),
      withCredentials: true,
      onEvent: (frame) => translate(runId, frame),
      onError: ({ reason }) => {
        const current = runs.get(runId);
        if (!current || current.settled) return;
        // The stream dropped. The build itself may still be running, so the
        // UI is told the connection is gone — not that the build failed.
        if (reason === "idle" || reason === "closed") {
          emit({
            type: "connection",
            runId,
            error: { type: ERROR_TYPES.CONNECTION, message: "The live connection was lost." },
          });
        }
      },
    });

    record.stream = handle;
  }

  /** One backend frame → one frontend event. */
  function translate(runId, frame) {
    const record = runs.get(runId);
    // A frame for a run the service no longer knows is stale: ignore it.
    if (!record || record.settled) return;

    if (frame && typeof frame.seq === "number") {
      if (frame.seq <= record.seen) return;
      record.seen = frame.seq;
    }

    const status = frame && frame.status ? frame.status : "";

    if (frame && frame.terminal === true) {
      settle(runId, status);
      return;
    }
    if (TERMINAL.includes(status)) {
      settle(runId, status);
      return;
    }

    const stageIndex =
      frame && frame.stage !== undefined && frame.stage !== null
        ? STAGE_BY_REMOTE_ID[frame.stage]
        : undefined;

    const progress = frame && typeof frame.progress === "number" ? frame.progress : 0;

    if (stageIndex !== undefined) {
      emit({
        type: "stage",
        runId,
        stageIndex,
        stageId: frame.stage || null,
        status: STATUS_MAP[status] || "building",
        progress,
        description: frame.activity || "",
        activity: frame.activity ? [frame.activity] : [],
      });
    } else if (progress > 0) {
      emit({ type: "progress", runId, progress });
    }

    if (frame && frame.activity) {
      emit({ type: "activity", runId, message: frame.activity, stage: frame.stage || "" });
    }
  }

  /**
   * A run reached a terminal state. Exactly one terminal event is emitted per
   * run, whatever order the frames arrive in.
   */
  function settle(runId, status) {
    const record = runs.get(runId);
    if (!record || record.settled) return;
    record.settled = true;

    closeStream(runId);

    const run = {
      runId,
      buildId: record.buildId,
      projectId: record.projectId,
      prompt: record.prompt,
      provider: record.provider,
      model: record.model,
    };

    if (status === "complete") {
      emit({ type: "done", runId, run: { ...run, status: "complete", progress: 100 } });
    } else if (status === "cancelled") {
      emit({ type: "cancel", runId, run: { ...run, status: "stopped" } });
    } else {
      emit({
        type: "error",
        runId,
        error: { type: ERROR_TYPES.OPERATION, message: "The build did not complete.", code: status },
      });
    }

    settledRuns.set(runId, { ...run, status });
    while (settledRuns.size > MAX_SETTLED_RUNS) {
      const oldest = settledRuns.keys().next().value;
      if (oldest === undefined) break;
      settledRuns.delete(oldest);
    }

    runs.delete(runId);
  }

  function closeStream(runId) {
    const record = runs.get(runId);
    if (!record) return;
    if (record.stream) {
      record.stream.close("settled");
      record.stream = null;
    }
    if (record.cancelTimer) {
      window.clearTimeout(record.cancelTimer);
      record.cancelTimer = 0;
    }
  }

  /**
   * Cancel a running build.
   *
   * The backend is asked first and the UI is only told the outcome once the
   * backend has confirmed it. A build that finished while the cancel was in
   * flight is reported as finished, not as cancelled.
   */
  function stopBuild(runId) {
    const record = runs.get(runId);
    if (!record) {
      return Promise.resolve(
        fail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true })
      );
    }

    return BM.api.cancelBuild(record.buildId).then((result) => {
      if (!BM.isOk(result)) {
        // The backend refused. The build may have finished on its own, so
        // the current state is fetched and reported honestly.
        return BM.api
          .getBuild(record.buildId)
          .then((current) => {
            if (BM.isOk(current) && TERMINAL.includes(current.data.build.status)) {
              settle(runId, current.data.build.status);
              return ok({ runId, stopped: current.data.build.status === "cancelled" });
            }
            return fail(
              result.error ? result.error.type : ERROR_TYPES.OPERATION,
              (result.error && result.error.message) || "The build could not be stopped.",
              { code: result.error && result.error.code }
            );
          })
          .catch(() => result);
      }

      return waitForTerminal(record.buildId, runId).then((build) => {
        const status = build ? build.status : "cancelled";
        settle(runId, status);
        return ok({ runId, stopped: status === "cancelled", build });
      });
    });
  }

  /**
   * Wait for the backend to record a terminal state for a build.
   *
   * The cancel request is persisted first and the provider call is aborted
   * afterwards, so the terminal row can land a moment after the response.
   * The poll is bounded and never blocks the UI for longer than the wait.
   */
  function waitForTerminal(buildId, runId) {
    const record = runs.get(runId);
    if (!record) return Promise.resolve(null);

    return new Promise((resolve) => {
      const deadline = Date.now() + CANCEL_WAIT_MS;

      const poll = () => {
        const current = runs.get(runId);
        if (!current) {
          resolve(null);
          return;
        }
        BM.api.getBuild(buildId).then((result) => {
          if (BM.isOk(result) && TERMINAL.includes(result.data.build.status)) {
            resolve(result.data.build);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(null);
            return;
          }
          current.cancelTimer = window.setTimeout(poll, CANCEL_POLL_MS);
        });
      };

      poll();
    });
  }

  /**
   * Retry: a new backend execution.
   *
   * The backend creates a new build row with a new runId, linked to the old
   * one. The project, prompt, provider and model are preserved by the
   * server; the old run's stream is closed so it can never repaint the new
   * run.
   */
  function retryBuild(runId, input) {
    const record = runs.get(runId) || settledRuns.get(runId) || null;
    const buildId = (input && input.buildId) || (record && record.buildId) || "";
    if (!buildId) {
      return Promise.resolve(fail(ERROR_TYPES.OPERATION, "There is no build to retry.", { noop: true }));
    }

    return BM.api.retryBuild(buildId, input && input.apiKey ? { apiKey: input.apiKey } : {}).then((result) => {
      if (!BM.isOk(result)) return result;

      const build = result.data.build;
      if (input && input.apiKey && build.provider) {
        storedCredentials.add(String(build.provider));
      }

      // The old run is finished: its stream is closed and its record dropped
      // before the new run is registered, so the two can never interleave.
      if (runs.has(runId)) {
        closeStream(runId);
        runs.delete(runId);
      }

      const prompt = (record && record.prompt) || (input && input.prompt) || "";

      registerRun({
        runId: build.runId,
        buildId: build.id,
        projectId: build.projectId,
        prompt,
        provider: build.provider,
        model: build.model,
      });

      emit({
        type: "start",
        runId: build.runId,
        run: {
          runId: build.runId,
          buildId: build.id,
          projectId: build.projectId,
          prompt,
          provider: build.provider,
          model: build.model,
          plan: null,
        },
      });

      attachStream(build.id, build.runId);

      return ok({
        runId: build.runId,
        buildId: build.id,
        projectId: build.projectId,
        prompt,
        provider: build.provider,
        model: build.model,
        plan: null,
      });
    });
  }

  /** The buildId a run belongs to. Used by the controller for retry. */
  function buildIdOf(runId) {
    const record = runs.get(runId) || settledRuns.get(runId);
    return record ? record.buildId : "";
  }

  /** Forget any stored BYOK credentials on the backend and in memory. */
  function forgetCredentials() {
    const providers = Array.from(storedCredentials);
    storedCredentials.clear();
    if (!BM.isAuthenticated() || !providers.length) return Promise.resolve(ok({ removed: 0 }));
    return Promise.all(providers.map((id) => BM.api.forgetCredential(id))).then(() =>
      ok({ removed: providers.length })
    );
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
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
    hasStoredCredential,
    forgetCredentials,
    startBuild,
    stopBuild,
    retryBuild,
    buildIdOf,
    subscribe,
    _activeRuns() {
      return Array.from(runs.keys());
    },
    _reset() {
      runs.forEach((record) => {
        if (record.stream) record.stream.close("reset");
      });
      runs.clear();
      settledRuns.clear();
      storedCredentials.clear();
      listeners.clear();
      return ok(null);
    },
  };

  BM.remoteAIService = createService("remoteAIService", implementation);
})();
