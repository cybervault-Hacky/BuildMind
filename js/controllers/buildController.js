/* ==========================================================================
   BuildMind — controllers/buildController.js
   Orchestrates one build: validate → project → AI service → state updates →
   service cleanup. The Build renderer calls into this file; it never touches
   the AI service or the build machine directly.

   Ownership:
     • build machine (status, stage, progress, runId) → js/state.js
     • stage timing and events                        → aiService
     • this file                                      → translation only

   Stale-run protection: every run carries a `runId`. Events from the service
   are matched against the active id, so a late event from a stopped run can
   never repaint the UI.

   The real backend needs a project before it can accept a build, so a build
   that has no project yet creates one first. That project is the record the
   build belongs to — there is no second, invisible copy.

   Cancellation and retry are server operations. The UI is only told the
   outcome once the backend has confirmed it.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES, BUILD, RUNNING_STATUSES } = BM;

  let activeRunId = null;
  let activeBuildId = "";
  let retryableRun = null;
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
    if (supplied || keySuppliedThisSession || BM.getState().apiKeyPresent) return true;
    // The backend may already hold a credential for this provider (a key
    // validated earlier in the session). It is the authority on that.
    const provider = BM.getState().settings.provider;
    if (provider && BM.aiService && typeof BM.aiService.hasStoredCredential === "function") {
      return Boolean(BM.aiService.hasStoredCredential(provider));
    }
    return false;
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
     The project a build belongs to

     The backend stores every build against a project, so a build with no
     project has to create one. The name is derived from the prompt by the
     same helper the local service used, and the record is written once.
     ------------------------------------------------------------------------ */
  function ensureProject(input) {
    const activeId = BM.getState().activeProjectId;
    const existing = activeId
      ? BM.getState().projects.find((project) => project.id === activeId)
      : null;

    if (existing) return Promise.resolve(BM.serviceOk({ project: existing }));

    const prompt = String(input.prompt || "").trim();
    const name = BM.projectNameFromPrompt(prompt);
    const description = BM.projectModel.describeFromPrompt(prompt);

    return BM.projectController
      .create({ name, description, prompt })
      .then((result) => {
        if (!BM.isOk(result)) return result;
        return BM.serviceOk({ project: result.data.project });
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
      // The key is handed to the service in memory only; it is never stored
      // locally, never put in a URL and never logged. The store keeps a
      // presence flag.
      const request = {
        prompt: config.prompt,
        provider: settings.provider,
        model: settings.model,
        hasKey: hasKey(config),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      };

      return ensureProject(request).then((project) => {
        if (!BM.isOk(project)) {
          return BM.serviceFail(
            project.error ? project.error.type : ERROR_TYPES.OPERATION,
            (project.error && project.error.message) || "The project could not be prepared.",
            { fields: project.error && project.error.fields }
          );
        }

        const projectId = project.data.project.id;
        BM.setActiveProject(projectId);

        return BM.aiService.startBuild({ ...request, projectId }).then((result) => {
          if (!BM.isOk(result)) {
            // Nothing started: return to a clean ready state, never a stuck
            // `preparing` phase.
            BM.resetBuild();
            return result;
          }

          const run = result.data;
          activeRunId = run.runId;
          activeBuildId = run.buildId || "";
          retryableRun = {
            runId: run.runId,
            buildId: run.buildId || "",
            prompt: run.prompt || request.prompt || "",
          };
          attach();

          // `preparing` is the acknowledged-click state; the first service event
          // moves the machine into `building`.
          BM.prepareRun({
            prompt: run.prompt,
            provider: run.provider,
            model: run.model,
            runId: run.runId,
            needsFix: false,
          });

          return BM.serviceOk({
            runId: run.runId,
            buildId: run.buildId,
            projectId,
            plan: run.plan,
          });
        });
      });
    });
  }

  /* ------------------------------------------------------------------------
     Stop — cancel on the backend first, then settle the machine.

     The order matters: the UI must not claim the build stopped before the
     server has recorded it. If the build finished while the cancel was in
     flight, the backend's answer wins and the machine settles on that.
     ------------------------------------------------------------------------ */
  function stop() {
    const preparing = build().phase === "preparing";
    if (!isRunning() && !preparing) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true }));
    }

    const runId = activeRunId;
    const hadProject = Boolean(BM.getState().activeProjectId);

    // The service is told first so it stops emitting, then the machine
    // settles. `endRun` bumps the run id, which makes any straggling event
    // stale.
    return BM.aiService.stopBuild(runId).then((result) => {
      if (!BM.isOk(result)) {
        // The backend refused. Nothing is settled: the UI keeps saying the
        // build is running, because it might still be.
        return result;
      }

      detach();
      activeRunId = null;
      activeBuildId = "";

      const stopped = result.data && result.data.stopped;
      if (stopped) {
        const done = BM.endRun("stopped");
        if (done && hadProject) BM.projectController?.markRun?.("stopped", runId);
      } else {
        // A race: the build reached a terminal state on its own. The server
        // is the authority, so the machine follows it.
        const done = BM.endRun("error-clear");
        if (done && hadProject) BM.projectController?.markRun?.("stopped", runId);
      }

      return BM.serviceOk({ stopped: Boolean(stopped), runId });
    });
  }

  /**
   * Retry: a new backend execution.
   *
   * The service asks the backend for a new build and a new run, preserving
   * the project, the prompt, the provider and the model. The old run's
   * stream is closed before the new one starts, so the two can never
   * interleave.
   */
  function retry(input) {
    if (isBusy()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "A build is already running.", { duplicate: true }));
    }

    const opts = input || {};
    const prompt = (retryableRun && retryableRun.prompt) || build().prompt;
    const service = BM.aiService;
    if (opts.apiKey) keySuppliedThisSession = true;

    if (typeof service.retryBuild !== "function") {
      // The simulated service has no retry endpoint: start a fresh run.
      BM.endRun("error-clear");
      return start({
        prompt,
        hasKey: Boolean(opts.apiKey) || keySuppliedThisSession || BM.getState().apiKeyPresent,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      });
    }

    const previousRunId = activeRunId || (retryableRun && retryableRun.runId) || build().runId;
    const previousBuildId =
      activeBuildId ||
      (retryableRun && retryableRun.buildId) ||
      (typeof service.buildIdOf === "function" ? service.buildIdOf(previousRunId) : "");

    return service
      .retryBuild(previousRunId, {
        buildId: previousBuildId,
        prompt,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      })
      .then((result) => {
        if (!BM.isOk(result)) {
          return result;
        }

        const run = result.data;
        detach();
        activeRunId = run.runId;
        activeBuildId = run.buildId || "";
        retryableRun = {
          runId: run.runId,
          buildId: run.buildId || "",
          prompt: run.prompt || prompt,
        };
        attach();

        BM.prepareRun({
          prompt: run.prompt || prompt,
          provider: run.provider,
          model: run.model,
          runId: run.runId,
          needsFix: false,
        });

        return BM.serviceOk({ runId: run.runId, buildId: run.buildId });
      });
  }

  /** Explicit failure used by the UI's controls and by tests. */
  function fail(reason) {
    if (!isRunning()) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.OPERATION, "No build is running.", { noop: true }));
    }
    const runId = activeRunId;
    const hadProject = Boolean(BM.getState().activeProjectId);
    detach();
    activeRunId = null;

    const settle = () => {
      BM.endRun("error", reason || "Build could not be completed");
      if (hadProject) BM.projectController?.markRun?.("error", runId);
    };
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
    activeBuildId = "";
    retryableRun = null;
    keySuppliedThisSession = false;
    BM.resetBuild();
    return BM.serviceOk(null);
  }

  /** Stop whatever is in flight, including a run still preparing. */
  function cancel() {
    const runId = activeRunId;
    detach();
    activeRunId = null;
    activeBuildId = "";
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
    if (event.type === "cancel") { onCancel(event); return; }
    if (event.type === "connection") { onConnectionLost(event); return; }
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

  function onError(event) {
    const runId = activeRunId;
    const hadProject = Boolean(BM.getState().activeProjectId);
    detach();
    activeRunId = null;
    activeBuildId = "";
    // User-facing copy only; the service's internal detail never surfaces.
    BM.endRun("error", (event.error && event.error.message) || "Build could not be completed");
    if (hadProject) BM.projectController?.markRun?.("error", runId);
  }

  /** The backend confirmed the cancellation. */
  function onCancel() {
    const runId = activeRunId;
    const hadProject = Boolean(BM.getState().activeProjectId);
    detach();
    activeRunId = null;
    activeBuildId = "";
    BM.endRun("stopped");
    if (hadProject) BM.projectController?.markRun?.("stopped", runId);
  }

  /**
   * The live connection dropped. The build may still be running on the
   * server, so the UI says the connection was lost — it does not claim the
   * build failed, and it does not pretend it completed.
   */
  function onConnectionLost(event) {
    BM.toast?.((event.error && event.error.message) || "The live connection was lost.");
  }

  /**
   * The run finished. Completion belongs only to the active run, and only one
   * completion per run can ever record a project.
   */
  function finish(run) {
    detach();
    activeRunId = null;
    activeBuildId = "";
    retryableRun = null;

    if (build().runId !== run.runId) return;
    if (build().status === "complete") return;

    BM.completeRun({ prompt: run.prompt, runId: run.runId });
  }

  /**
   * Called by the store as the last step of completion. The project is
   * refreshed through projectService — never by editing the array by hand.
   */
  function recordCompletion(prompt, runId) {
    const projectId = BM.getState().activeProjectId;
    if (!projectId) return Promise.resolve(BM.serviceOk(null));

    return BM.projectController.recordBuild({ prompt, runId, projectId }).then((result) => {
      if (!BM.isOk(result)) return result;

      const project = result.data.project;
      BM.setRunResult({
        name: project.name,
        projectId: project.id,
        status: project.status,
        validation: project.status === "complete" ? "passed" : "pending",
      });
      return result;
    });
  }

  BM.buildController = {
    mode: "remote",
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
    activeBuildId() {
      return activeBuildId;
    },
  };
})();
