/* ==========================================================================
   BuildMind — controllers/buildController.js
   Orchestrates one build: validate → AI service → state updates → service
   cleanup. The Build renderer calls into this file; it never touches the AI
   service or the build machine directly.

   Ownership:
     • build machine (status, stage, progress, runId) → js/state.js
     • stage timing and events                        → aiService
     • this file                                      → translation only

   Stale-run protection: every run carries a `runId`. Events from the service
   are matched against the active id, so a late event from a stopped run can
   never repaint the UI.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES, BUILD, RUNNING_STATUSES, LAST_STAGE } = BM;

  let activeRunId = null;
  let unsubscribe = null;
  /**
   * True once a key has been supplied during this page session. Only a
   * boolean is remembered — never the value, which is dropped after submit.
   */
  let keySuppliedThisSession = false;

  function build() {
    return BM.getState().build;
  }

  /**
   * A build is "in flight" from the moment the click is accepted, which
   * includes the short `preparing` phase before the first stage arrives.
   * Treating preparing as in-flight is what makes repeated clicks safe.
   */
  function isBusy() {
    return isRunning() || build().phase === "preparing";
  }

  function isRunning() {
    return RUNNING_STATUSES.indexOf(build().status) !== -1;
  }

  /* ------------------------------------------------------------------------
     Configuration — one validation path for every caller.
     ------------------------------------------------------------------------ */
  function hasKey(input) {
    const supplied = Boolean(input && input.hasKey);
    if (supplied) keySuppliedThisSession = true;
    return supplied || keySuppliedThisSession || BM.getState().apiKeyPresent;
  }

  function validate(input) {
    const config = input || {};
    const { settings } = BM.getState();

    return BM.aiService.validateConfiguration({
      prompt: config.prompt,
      provider: settings.provider,
      model: settings.model,
      hasKey: hasKey(config),
    });
  }

  /** Validate and apply: returns the envelope so the renderer can paint fields. */
  function checkConfiguration(input) {
    return validate(input).then((result) => {
      // Field errors are the one place the machine and the AI boundary agree;
      // keep the store's own validator in step so both stay honest.
      const local = BM.validateBuildConfig({
        prompt: (input || {}).prompt,
        apiKey: hasKey(input) ? "present" : "",
      });
      return BM.serviceOk({
        valid: BM.isOk(result) && result.data.valid && local.valid,
        errors: BM.isOk(result) ? { ...local.errors, ...result.data.errors } : local.errors,
      });
    });
  }

  /* ------------------------------------------------------------------------
     Start
     ------------------------------------------------------------------------ */
  function start(input) {
    const config = input || {};
    if (isBusy()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "A build is already running.", { duplicate: true }));
    }

    return checkConfiguration(config).then((check) => {
      if (!BM.isOk(check) || !check.data.valid) {
        return BM.serviceFail(ERROR_TYPES.VALIDATION, "Check the highlighted fields.", {
          fields: BM.isOk(check) ? check.data.errors : {},
        });
      }

      const { settings } = BM.getState();
      // The key is handed to the service in memory only; it is never stored,
      // never put in a URL and never logged. The store keeps a presence flag.
      const request = {
        prompt: config.prompt,
        provider: settings.provider,
        model: settings.model,
        hasKey: hasKey(config),
      };

      return BM.aiService.startBuild(request).then((result) => {
        if (!BM.isOk(result)) {
          // Nothing started: return to a clean ready state, never a stuck
          // `preparing` phase.
          BM.resetBuild();
          return result;
        }

        const run = result.data;
        activeRunId = run.runId;
        attach();

        // `preparing` is the acknowledged-click state; the first service event
        // moves the machine into `building`.
        BM.prepareRun({
          prompt: run.prompt,
          provider: run.provider,
          model: run.model,
          runId: run.runId,
          needsFix: Boolean(run.plan && run.plan.needsFix),
        });

        return BM.serviceOk({ runId: run.runId, plan: run.plan });
      });
    });
  }

  /* ------------------------------------------------------------------------
     Stop — cancel the service first, then settle the machine.
     ------------------------------------------------------------------------ */
  function stop() {
    const preparing = build().phase === "preparing";
    if (!isRunning() && !preparing) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true }));
    }

    const runId = activeRunId;
    detach();
    activeRunId = null;
    // The service is told first so it stops emitting, then the machine settles.
    // `endRun` bumps the run id, which makes any straggling event stale.
    const done = BM.endRun("stopped");

    return BM.aiService.stopBuild(runId).then(() =>
      BM.serviceOk({ stopped: done, runId })
    );
  }

  /** Retry after a simulated failure: clean reset, then the same prompt. */
  function retry() {
    if (isBusy()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "A build is already running.", { duplicate: true }));
    }

    const prompt = build().prompt;
    // A key supplied earlier in this session is remembered as a flag, so a
    // retry does not ask the user to type it again.
    BM.endRun("error-clear");
    // `endRun` has already returned the machine to a clean ready state; going
    // through `prepareRun` here would leave it stuck in `preparing`, because
    // the first service event (which clears that phase) has not arrived yet.
    return start({ prompt, hasKey: keySuppliedThisSession || BM.getState().apiKeyPresent });
  }

  /** Explicit failure used by the UI's simulated-error control and by tests. */
  function fail(reason) {
    if (!isRunning()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true }));
    }
    const runId = activeRunId;
    detach();
    activeRunId = null;

    const settle = () => BM.endRun("error", reason || "Build could not be completed");
    const service = BM.aiService;
    if (service && typeof service.failBuild === "function" && runId) {
      return service.failBuild(runId).then(() => {
        settle();
        return BM.serviceOk({ failed: true });
      });
    }

    settle();
    return Promise.resolve(BM.serviceOk({ failed: true }));
  }

  function reset() {
    detach();
    activeRunId = null;
    BM.resetBuild();
    return BM.serviceOk(null);
  }

  /** Stop whatever is in flight, including a run still preparing. */
  function cancel() {
    const runId = activeRunId;
    detach();
    activeRunId = null;
    BM.resetBuild();
    if (runId) BM.aiService.stopBuild(runId);
    return BM.serviceOk(null);
  }

  /* ------------------------------------------------------------------------
     Service event → state machine
     ------------------------------------------------------------------------ */
  function attach() {
    detach();
    unsubscribe = BM.aiService.subscribe(handle);
  }

  function detach() {
    if (typeof unsubscribe === "function") unsubscribe();
    unsubscribe = null;
  }

  function handle(event) {
    if (!event) return;
    // Every event must belong to the run we are driving.
    if (event.runId !== activeRunId) return;

    if (event.type === "stage") { onStage(event); return; }
    if (event.type === "progress") { BM.setRunProgress(event.progress); return; }
    if (event.type === "activity") { BM.addActivity(event.message); return; }
    if (event.type === "done") { finish(event); return; }
    if (event.type === "error") { onError(event); return; }
    if (event.type === "cancel") { detach(); activeRunId = null; }
  }

  function onStage(event) {
    const index = typeof event.stageIndex === "number" ? event.stageIndex : -1;
    if (index < 0) return;

    // The first stage is what actually starts the machine.
    if (!BM.isRunning()) {
      BM.beginRun({ runId: event.runId, prompt: build().prompt });
    }

    BM.advanceRun({
      stage: index,
      stageId: event.stageId,
      stageLabel: event.stageLabel,
      description: event.description,
      progress: event.progress,
      status: event.status,
    });
  }

  function onError() {
    detach();
    activeRunId = null;
    // User-facing copy only; the service's internal detail never surfaces.
    BM.endRun("error", "Build could not be completed");
  }

  /**
   * The run finished. Completion belongs only to the active run, and only one
   * completion per run can ever record a project.
   */
  function finish(run) {
    detach();
    activeRunId = null;

    if (build().runId !== run.runId) return;
    if (build().status === "complete") return;

    BM.completeRun({ prompt: run.prompt, runId: run.runId });
  }

  /**
   * Called by the store as the last step of completion. The project is created
   * or updated through projectService — never by editing the array by hand.
   */
  function recordCompletion(prompt) {
    return BM.projectController.recordBuild(prompt).then((result) => {
      if (!BM.isOk(result)) return result;

      const project = result.data.project;
      BM.setRunResult({
        name: project.name,
        projectId: project.id,
        status: project.status,
        validation: "passed",
      });
      return result;
    });
  }

  BM.buildController = {
    mode: "mock",
    isBusy,
    cancel,
    validate,
    checkConfiguration,
    start,
    stop,
    retry,
    fail,
    reset,
    isRunning,
    recordCompletion,
    activeRunId() {
      return activeRunId;
    },
  };
})();
