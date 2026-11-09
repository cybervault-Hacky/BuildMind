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

  function build() {
    return BM.getState().build;
  }

  function isRunning() {
    return RUNNING_STATUSES.indexOf(build().status) !== -1;
  }

  /* ------------------------------------------------------------------------
     Configuration — one validation path for every caller.
     ------------------------------------------------------------------------ */
  function validate(input) {
    const config = input || {};
    const { settings, apiKeyPresent } = BM.getState();

    return BM.aiService.validateConfiguration({
      prompt: config.prompt,
      provider: settings.provider,
      model: settings.model,
      hasKey: Boolean(config.hasKey) || apiKeyPresent,
    });
  }

  /** Validate and apply: returns the envelope so the renderer can paint fields. */
  function checkConfiguration(input) {
    return validate(input).then((result) => {
      // Field errors are the one place the machine and the AI boundary agree;
      // keep the store's own validator in step so both stay honest.
      const local = BM.validateBuildConfig({
        prompt: (input || {}).prompt,
        apiKey: (input || {}).hasKey ? "present" : "",
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
    if (isRunning()) {
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
        hasKey: Boolean(config.hasKey) || BM.getState().apiKeyPresent,
      };

      return BM.aiService.startBuild(request).then((result) => {
        if (!BM.isOk(result)) return result;

        const run = result.data;
        activeRunId = run.runId;
        attach();

        const started = BM.beginRun({
          prompt: run.prompt,
          provider: run.provider,
          model: run.model,
          runId: run.runId,
        });

        if (!started) {
          BM.aiService.stopBuild(run.runId);
          activeRunId = null;
          return BM.serviceFail(ERROR_TYPES.OPERATION, "The build could not start.");
        }

        return BM.serviceOk({ runId: run.runId });
      });
    });
  }

  /* ------------------------------------------------------------------------
     Stop — cancel the service first, then settle the machine.
     ------------------------------------------------------------------------ */
  function stop() {
    if (!isRunning()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true }));
    }

    const runId = activeRunId;
    detach();
    activeRunId = null;
    BM.endRun("stopped");

    return BM.aiService.stopBuild(runId).then(() => BM.serviceOk({ stopped: true, runId }));
  }

  /** Retry after a simulated failure: clean reset, then the same prompt. */
  function retry() {
    if (isRunning()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "A build is already running.", { duplicate: true }));
    }

    const prompt = build().prompt;
    BM.endRun("error-clear");
    return start({ prompt, hasKey: BM.getState().apiKeyPresent });
  }

  /** Explicit failure used by the UI's simulated-error control and by tests. */
  function fail(reason) {
    if (!isRunning()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true }));
    }
    const runId = activeRunId;
    detach();
    activeRunId = null;
    BM.endRun("error", reason);
    return BM.aiService.stopBuild(runId).then(() => BM.serviceOk({ failed: true }));
  }

  function reset() {
    detach();
    activeRunId = null;
    BM.resetBuild();
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
    if (!event || !event.run) return;
    if (event.run.runId !== activeRunId) return; // stale run: ignored

    if (event.type === "stage") {
      const index = event.run.stageIndex;
      const stage = event.run.stage;
      if (!stage) return;

      if (index >= LAST_STAGE) {
        // The final stage is completion. Only here is a project produced.
        finish(event.run);
        return;
      }

      BM.advanceRun({ stage: index, progress: stage.progress, status: stage.status });
      return;
    }

    if (event.type === "done") finish(event.run);

    if (event.type === "cancel") {
      detach();
      activeRunId = null;
    }
  }

  function finish(run) {
    detach();
    activeRunId = null;
    BM.completeRun({ prompt: run.prompt, runId: run.runId });
  }

  /**
   * Called by the store as the last step of completion. The project is created
   * or updated through projectService — never by editing the array by hand.
   */
  function recordCompletion(prompt) {
    return BM.projectController.recordBuild(prompt);
  }

  BM.buildController = {
    mode: "mock",
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
