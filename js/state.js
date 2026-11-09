/* ==========================================================================
   BuildMind — state.js
   The single owner of application state.

   Layer responsibilities (see README):
     UI (build/projects/settings/navigation)
       ↓ user intent
     Controllers (build/connection/project/settings)
       ↓ service calls
     Services (ai/roblox/studio/projects/settings)
       ↓ results
     THIS FILE — the only writer of state → subscribers → renderers

   What lives here: the state object, subscribe/getState, the build state
   machine, and small "apply" functions that only accept data other layers
   have already produced. What does not live here: persistence (services),
   provider lists (services/ai/providers.js), build stage timings (services/
   ai/stages.js), connection simulation (services/connections) and any project
   or settings I/O.

   Nothing in this file performs a network request, and no API key is ever
   stored: only an `apiKeyPresent` boolean exists, in memory.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  /* ------------------------------------------------------------------------
     Build state machine
     A move is applied only when it appears in TRANSITIONS, so the UI can never
     show two contradictory states at once.
     ------------------------------------------------------------------------ */
  const BUILD = {
    READY: "ready",
    BUILDING: "building",
    TESTING: "testing",
    FIXING: "fixing",
    VALIDATING: "validating",
    COMPLETE: "complete",
    STOPPED: "stopped",
    ERROR: "error",
  };

  const RUNNING_STATUSES = [BUILD.BUILDING, BUILD.TESTING, BUILD.FIXING, BUILD.VALIDATING];
  const TERMINAL_STATUSES = [BUILD.COMPLETE, BUILD.STOPPED, BUILD.ERROR];

  const TRANSITIONS = {
    ready: [BUILD.BUILDING],
    building: [BUILD.TESTING, BUILD.BUILDING, BUILD.STOPPED, BUILD.ERROR],
    testing: [BUILD.FIXING, BUILD.VALIDATING, BUILD.STOPPED, BUILD.ERROR],
    // A fixing pass may hand back to testing before validation — that loop is
    // the whole point of a fix. It is additive: no existing move is removed.
    fixing: [BUILD.TESTING, BUILD.VALIDATING, BUILD.STOPPED, BUILD.ERROR],
    validating: [BUILD.COMPLETE, BUILD.STOPPED, BUILD.ERROR],
    complete: [BUILD.READY, BUILD.BUILDING],
    stopped: [BUILD.READY, BUILD.BUILDING],
    error: [BUILD.READY, BUILD.BUILDING],
  };

  /** Human labels used by status pills and the live region. */
  const STATUS_LABEL = {
    ready: "Ready",
    building: "Building",
    testing: "Testing",
    fixing: "Fixing",
    validating: "Validating",
    complete: "Complete",
    stopped: "Stopped",
    error: "Failed",
  };

  /** Status pill tone per state — never the only signal (text always too). */
  const STATUS_TONE = {
    ready: "idle",
    building: "active",
    testing: "active",
    fixing: "warn",
    validating: "active",
    complete: "ready",
    stopped: "idle",
    error: "error",
  };

  /**
   * Project status vocabulary shared by cards and filters.
   *
   * These are the same nine states the build machine uses, plus `draft` for a
   * project that exists but has no prompt yet. No project state exists that
   * the frontend cannot actually reach: transient states are only ever set by
   * a live run, and every one of them is a real value in `BUILD`.
   */
  const PROJECT_STATUS = {
    draft: { label: "Draft", tone: "idle" },
    ready: { label: "Ready", tone: "ready" },
    building: { label: "Building", tone: "active" },
    testing: { label: "Testing", tone: "active" },
    fixing: { label: "Fixing", tone: "warn" },
    validating: { label: "Validating", tone: "active" },
    complete: { label: "Complete", tone: "ready" },
    stopped: { label: "Stopped", tone: "idle" },
    error: { label: "Failed", tone: "error" },
  };

  /** Lifecycle order used by the filter row — a build reads naturally. */
  const PROJECT_STATUS_ORDER = [
    "draft",
    "ready",
    "building",
    "testing",
    "fixing",
    "validating",
    "complete",
    "stopped",
    "error",
  ];

  /* ------------------------------------------------------------------------
     The state object
     ------------------------------------------------------------------------ */
  const state = {
    page: document.body ? document.body.dataset.page || "" : "",
    settings: {
      provider: "",
      model: "",
      autoFix: true,
      hints: true,
    },
    motion: "full",
    connections: {
      roblox: { status: "disconnected" }, // disconnected | connecting | connected
      studio: { status: "disconnected" },
    },
    apiKeyPresent: false,
    build: {
      status: BUILD.READY,
      stage: -1,
      progress: 0,
      prompt: "",
      provider: "",
      model: "",
      runId: 0,
      startedAt: 0,
      endedAt: 0,
      error: "",
      // Phase 5 additions
      phase: "ready",     // ready | preparing | running — "preparing" is the
                          // moment between the click and the first stage
      stageLabel: "",
      stageDescription: "",
      activity: [],       // [{ id, stage, message }] newest last
      result: null,       // { name, projectId, status, validation, createdAt }
      visits: {},         // stage id → times entered (a fixing loop revisits testing)
      needsFix: false,
    },
    projects: [],
    projectsFilter: "all",
    projectsQuery: "",
    /** The project the Build composer is working on, if any. */
    activeProjectId: "",
    services: { mode: "unknown", ready: false },
  };

  const listeners = new Set();

  function snapshot() {
    return {
      ...state,
      settings: { ...state.settings },
      connections: {
        roblox: { ...state.connections.roblox },
        studio: { ...state.connections.studio },
      },
      build: {
        ...state.build,
        activity: state.build.activity.slice(),
        result: state.build.result ? { ...state.build.result } : null,
        visits: { ...state.build.visits },
      },
      projects: state.projects.slice(),
      services: { ...state.services },
    };
  }

  /**
   * Subscribe to state changes.
   * @param {(state: object, changed: string[]) => void} fn
   * @returns {() => void} unsubscribe
   */
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify(changed) {
    const view = snapshot();
    listeners.forEach((fn) => {
      try {
        fn(view, changed);
      } catch (err) {
        // One broken listener must never break the app.
        console.error("[BuildMind] render failed", err);
      }
    });
  }

  /* ------------------------------------------------------------------------
     Apply functions — called by controllers with already-validated data.
     They never fetch, persist or validate against a provider.
     ------------------------------------------------------------------------ */
  function findProviderConfig(id) {
    return BM.providerCatalog ? BM.providerCatalog.resolve(id) : null;
  }

  function applySettings(settings) {
    if (!settings) return;
    state.settings = { ...state.settings, ...settings };
    notify(["settings"]);
  }

  function applyMotion(mode) {
    const next = mode === "reduced" ? "reduced" : "full";
    BM.applyMotionPreference?.(next);
    if (next === state.motion) return;
    state.motion = next;
    notify(["motion"]);
  }

  function setApiKeyPresent(present) {
    const next = Boolean(present);
    if (next === state.apiKeyPresent) return;
    state.apiKeyPresent = next;
    notify(["apiKeyPresent"]);
  }

  function setPromptDraft(prompt) {
    const text = String(prompt === undefined || prompt === null ? "" : prompt);
    if (text === state.build.prompt) return;
    state.build = { ...state.build, prompt: text };
    // Draft persistence belongs to settingsService.
    BM.settingsService?.savePromptDraft(text);
    notify(["build"]);
  }

  function setServiceMode(mode, ready) {
    state.services = { mode: mode || "local", ready: Boolean(ready) };
    notify(["services"]);
  }

  /* ------------------------------------------------------------------------
     Connections — status only. The simulation lives in the services; this is
     the store side of it.
     ------------------------------------------------------------------------ */
  function setConnectionStatus(target, status) {
    if (!state.connections[target]) return;
    if (state.connections[target].status === status) return;

    state.connections = {
      ...state.connections,
      [target]: { ...state.connections[target], status },
    };
    notify(["connections"]);
  }

  function isConnected(target) {
    return Boolean(state.connections[target] && state.connections[target].status === "connected");
  }

  /* ------------------------------------------------------------------------
     Projects — the store holds the list; projectService reads/writes it.

     The array is not a second state owner: it is a mirror of what the service
     returned. Every write below takes an already-normalised project and only
     replaces a slot. Ordering, filtering and search are derived here so the
     renderer never sorts or copies data of its own.
     ------------------------------------------------------------------------ */
  function projectOrder(project) {
    if (!project) return 0;
    return Number(project.lastBuildAt || project.updatedAt || project.created || 0);
  }

  function sortProjects(projects) {
    return projects.slice().sort((a, b) => {
      const delta = projectOrder(b) - projectOrder(a);
      if (delta !== 0) return delta;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function setProjects(projects) {
    state.projects = Array.isArray(projects) ? sortProjects(projects.filter((p) => p && p.id)) : [];
    if (!projectFiltersExist(state.projectsFilter)) state.projectsFilter = "all";
    if (state.activeProjectId && !state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = "";
    }
    notify(["projects"]);
  }

  function insertProject(project) {
    if (!project || !project.id) return;
    state.projects = sortProjects([project, ...state.projects.filter((item) => item.id !== project.id)]);
    notify(["projects"]);
  }

  function replaceProject(project) {
    if (!project || !project.id) return;
    const existing = state.projects.some((item) => item.id === project.id);
    const next = existing
      ? state.projects.map((item) => (item.id === project.id ? { ...item, ...project } : item))
      : [project, ...state.projects];

    state.projects = sortProjects(next);
    notify(["projects"]);
  }

  function removeProject(id) {
    const projects = state.projects.filter((item) => item.id !== id);
    if (projects.length === state.projects.length) return;
    state.projects = projects;
    if (!projectFiltersExist(state.projectsFilter)) state.projectsFilter = "all";
    if (state.activeProjectId === id) state.activeProjectId = "";
    notify(["projects"]);
  }

  function setProjectFilter(filter) {
    const next = String(filter || "all");
    if (next === state.projectsFilter) return;
    state.projectsFilter = next;
    notify(["projectsFilter"]);
  }

  /** Local search over name + description. Never touches project data. */
  function setProjectQuery(query) {
    const next = String(query === undefined || query === null ? "" : query).slice(0, 60);
    if (next === state.projectsQuery) return;
    state.projectsQuery = next;
    notify(["projectsQuery"]);
  }

  /**
   * The project Build is currently working on. Setting it is a UI fact, not a
   * data change: it never mutates the project record itself.
   */
  function setActiveProject(id) {
    const next = typeof id === "string" && state.projects.some((p) => p.id === id) ? id : "";
    if (next === state.activeProjectId) return;
    state.activeProjectId = next;
    notify(["activeProjectId"]);
  }

  function getActiveProject() {
    if (!state.activeProjectId) return null;
    const found = state.projects.find((project) => project.id === state.activeProjectId);
    return found ? { ...found } : null;
  }

  function findProjectByRun(runId) {
    if (!runId) return null;
    const found = state.projects.find((project) => project.runId === runId);
    return found ? { ...found } : null;
  }

  /** Filters are derived from the statuses that actually exist. */
  function projectFilters() {
    const present = new Set(state.projects.map((project) => project.status));
    return [
      { id: "all", label: "All" },
      ...PROJECT_STATUS_ORDER.filter((status) => present.has(status)).map((status) => ({
        id: status,
        label: PROJECT_STATUS[status].label,
      })),
    ];
  }

  function projectFiltersExist(filter) {
    return projectFilters().some((item) => item.id === filter);
  }

  /* ------------------------------------------------------------------------
     Project naming — deterministic, frontend-only, no model involved.

     The goal is a short, readable card title. Three parts at most:
       1. the distinctive words from the idea, minus filler
       2. the genre word, always last when one is present
     Two-word prompts therefore read naturally, and long prompts stay short.
     ------------------------------------------------------------------------ */
  const NAME_FILLER = new Set([
    "a", "an", "the", "with", "and", "for", "of", "on", "in", "to", "where", "that",
    "players", "player", "game", "games", "map", "level", "mode", "some", "your", "my",
    "create", "make", "build", "design", "generate", "please", "should", "can", "both",
    "also", "into", "from", "has", "have", "use", "using", "based",
  ]);

  const NAME_GENRES = ["survival", "obby", "tycoon", "arena", "racing", "horror", "simulator", "defense", "mining"];
  const GENRE_SET = new Set(NAME_GENRES);
  const MAX_NAME_WORDS = 3;

  function titleCase(word) {
    if (!word) return "";
    // Keep hyphenated words readable ("Round-based").
    return word
      .split("-")
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
      .join("-");
  }

  function projectNameFromPrompt(prompt) {
    const cleaned = String(prompt || "")
      .replace(/\s+/g, " ")
      .replace(/[.!?]+$/g, "")
      .trim();

    if (!cleaned) return "Untitled game";

    const words = cleaned
      .split(" ")
      .map((word) => word.replace(/[^\w'-]/g, ""))
      .filter(Boolean);

    // The genre word goes last, whatever position it held in the prompt.
    const genre = words.find((word) => GENRE_SET.has(word.toLowerCase())) || "";
    const distinctive = words.filter(
      (word) => !NAME_FILLER.has(word.toLowerCase()) && word.toLowerCase() !== genre.toLowerCase()
    );

    const parts = distinctive.slice(0, genre ? MAX_NAME_WORDS - 1 : MAX_NAME_WORDS);
    if (genre) parts.push(genre);

    const title = (parts.length ? parts : words.slice(0, MAX_NAME_WORDS))
      .map(titleCase)
      .join(" ")
      .slice(0, 44)
      .trim();

    return title || "Untitled game";
  }

  /* ------------------------------------------------------------------------
     Build machine
     The controller decides *when* to move; this file decides whether the move
     is legal. Stage metadata comes from services/ai/stages.js.
     ------------------------------------------------------------------------ */
  function stages() {
    return BM.BUILD_STAGES || [];
  }

  function lastStageIndex() {
    return stages().length - 1;
  }

  function isRunning(build) {
    return RUNNING_STATUSES.indexOf((build || state.build).status) !== -1;
  }

  function canTransition(from, to) {
    return (TRANSITIONS[from] || []).indexOf(to) !== -1;
  }

  /**
   * Apply a build patch only when the status move is legal.
   * @param {object} patch
   * @param {boolean} [skipCheck] used by callers that have already decided the
   *   move is legal (a run stopped during the `preparing` beat, for instance)
   */
  function updateBuild(patch, skipCheck) {
    const next = { ...state.build, ...patch };

    if (!skipCheck && patch.status && patch.status !== state.build.status) {
      if (!canTransition(state.build.status, patch.status)) {
        console.warn(`[BuildMind] blocked build transition ${state.build.status} → ${patch.status}`);
        return false;
      }
    }

    state.build = next;
    notify(["build"]);
    return true;
  }

  const MAX_ACTIVITY = 40;

  function emptyBuild(prompt, runId) {
    return {
      status: BUILD.READY,
      stage: -1,
      progress: 0,
      prompt: prompt === undefined ? state.build.prompt : prompt,
      provider: state.settings.provider,
      model: state.settings.model,
      runId,
      startedAt: 0,
      endedAt: 0,
      error: "",
      phase: "ready",
      stageLabel: "",
      stageDescription: "",
      activity: [],
      result: null,
      visits: {},
      needsFix: false,
    };
  }

  /**
   * Controller: a build has been requested.
   * The machine stays `ready` but the phase becomes `preparing`, so the UI can
   * acknowledge the click before the first stage arrives.
   */
  function prepareRun(config) {
    if (isRunning()) return false;

    const input = config || {};
    const runId = input.runId || `run-${state.build.runId + 1}`;

    state.build = emptyBuild(String(input.prompt || "").trim(), runId);
    state.build.provider = input.provider || state.settings.provider;
    state.build.model = input.model || state.settings.model;
    state.build.phase = "preparing";
    state.build.needsFix = Boolean(input.needsFix);
    notify(["build"]);
    return true;
  }

  /** Controller: the service reported its first stage — the run is live. */
  function beginRun(config) {
    if (isRunning()) return false;

    const input = config || {};
    // `prepareRun` already reset the slice; this only moves it into building.
    if (state.build.runId !== (input.runId || state.build.runId)) {
      prepareRun(input);
    }

    return updateBuild({ status: BUILD.BUILDING, phase: "running", startedAt: Date.now() });
  }

  /** Controller: the service reported a stage. */
  function advanceRun(patch) {
    const input = patch || {};
    const index = Number.isInteger(input.stage) ? input.stage : state.build.stage;
    const stage = stages()[index];
    const stageId = input.stageId || (stage ? stage.id : "");

    const visits = { ...state.build.visits };
    if (stageId) {
      visits[stageId] = (visits[stageId] || 0) + 1;
    }

    // Progress is authoritative and monotonic: it never moves backwards, so a
    // repeat visit cannot pull the bar or the markers back.
    const target = typeof input.progress === "number" ? input.progress : stage ? stage.progress : state.build.progress;

    return updateBuild({
      stage: index,
      stageLabel: input.stageLabel || (stage ? stage.label : state.build.stageLabel),
      stageDescription: input.description || (stage ? stage.description : state.build.stageDescription),
      progress: Math.max(state.build.progress, target),
      status: input.status || (stage ? stage.status : state.build.status),
      visits,
    });
  }

  /** Controller: smoothed progress from the service (never decreases). */
  function setRunProgress(progress) {
    const next = Math.max(state.build.progress, Math.min(100, Number(progress) || 0));
    if (next === state.build.progress) return false;

    state.build = { ...state.build, progress: next };
    notify(["build"]);
    return true;
  }

  /** Controller: one simulated activity line for the event stream. */
  function addActivity(message) {
    const text = String(message || "").trim();
    if (!text) return false;

    const activity = state.build.activity.concat({
      id: `${state.build.runId}-${state.build.activity.length + 1}`,
      stage: state.build.stageLabel,
      message: text,
    });

    state.build = {
      ...state.build,
      activity: activity.slice(-MAX_ACTIVITY),
    };
    notify(["build"]);
    return true;
  }

  /** Controller: the service finished. The only path to `complete`. */
  function completeRun(config) {
    const input = config || {};
    const previousRun = state.build.runId;
    const endedAt = Date.now();

    const done = updateBuild({
      stage: lastStageIndex(),
      stageLabel: stages()[lastStageIndex()] ? stages()[lastStageIndex()].label : "Complete",
      stageDescription: stages()[lastStageIndex()] ? stages()[lastStageIndex()].description : "",
      progress: 100,
      status: BUILD.COMPLETE,
      phase: "ready",
      endedAt,
      error: "",
      result: {
        name: "",
        projectId: "",
        status: "complete",
        validation: "passed",
        createdAt: endedAt,
      },
    });

    if (done) {
      addActivity("Validation passed");
      // The controller records the project through projectService.
      BM.buildController?.recordCompletion?.(input.prompt || state.build.prompt, input.runId);
    }

    return done ? previousRun : null;
  }

  /** Controller: record the project that completion produced. */
  function setRunResult(result) {
    if (!state.build.result) return false;
    state.build = {
      ...state.build,
      result: { ...state.build.result, ...(result || {}) },
    };
    notify(["build"]);
    return true;
  }

  /** Controller: end a run as stopped or failed. Bumps runId to kill stale work. */
  function endRun(outcome, reason) {
    const next = outcome === "error" ? BUILD.ERROR : outcome === "error-clear" ? BUILD.READY : BUILD.STOPPED;

    // A run stopped during the `preparing` beat has not reached `building` yet;
    // it settles straight to `stopped` without inventing a transition.
    const preparing = state.build.phase === "preparing";

    // An illegal outcome must not touch the run id.
    if (next !== state.build.status && !canTransition(state.build.status, next)) {
      if (!preparing) return false;
    }

    if (next === BUILD.ERROR || next === BUILD.STOPPED) {
      // Bumping the run id is what makes any in-flight service event stale.
      state.build = { ...state.build, runId: `run-${Date.now().toString(36)}` };
    }

    return updateBuild(
      {
        status: next,
        phase: "ready",
        endedAt: next === BUILD.READY ? 0 : Date.now(),
        error: next === BUILD.ERROR ? reason || "The simulated run stopped unexpectedly." : "",
        // A stopped or failed run never produces a result.
        result: null,
      },
      preparing
    );
  }

  function resetBuild() {
    state.build = emptyBuild(state.build.prompt, `run-${Date.now().toString(36)}`);
    notify(["build"]);
  }

  /**
   * Frontend configuration validation kept for callers that have no service
   * handle. Controllers use `aiService.validateConfiguration` instead.
   */
  function validateBuildConfig(input) {
    const config = input || {};
    const provider = findProviderConfig(state.settings.provider);
    const errors = {};
    const text = String(config.prompt || "").trim();

    if (!text) errors.prompt = "Describe the game you want to build.";
    else if (text.length < 8) errors.prompt = "A little more detail, at least a sentence.";

    if (!provider) errors.provider = "Choose an AI provider.";
    else if (!provider.models.some((model) => model.id === state.settings.model)) {
      errors.model = "Choose a model for this provider.";
    }

    const hasKey = Boolean(config.apiKey && String(config.apiKey).trim()) || state.apiKeyPresent;
    if (provider && provider.requiresKey && !hasKey) {
      errors.apiKey = "Enter a key to run a build. It is never stored or sent.";
    }

    return { valid: Object.keys(errors).length === 0, errors };
  }

  /* ------------------------------------------------------------------------
     Boot — the store is filled by the settings/project controllers. This
     function only wires lifecycle and cross-tab sync.
     ------------------------------------------------------------------------ */
  function loadState() {
    // A fresh page starts with no run in flight and no key in memory.
    state.build = emptyBuild(state.build.prompt, 0);
    state.apiKeyPresent = false;
    return snapshot();
  }

  function initSync() {
    window.addEventListener("storage", (event) => {
      if (!event.key) return;

      if (event.key === BM.STORAGE_KEYS.settings || event.key === BM.STORAGE_KEYS.preferences) {
        BM.settingsController.load();
      } else if (event.key === BM.STORAGE_KEYS.connections) {
        BM.settingsService.loadSettings().then((result) => {
          if (!BM.isOk(result)) return;
          const { connections } = result.data;
          setConnectionStatus("roblox", connections.roblox ? "connected" : "disconnected");
          setConnectionStatus("studio", connections.studio ? "connected" : "disconnected");
        });
      } else if (event.key === BM.STORAGE_KEYS.projects) {
        BM.projectController.load();
      }
    });
  }

  /* ------------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------------ */
  Object.assign(BM, {
    BUILD,
    PROJECT_STATUS,
    RUNNING_STATUSES,
    TERMINAL_STATUSES,
    STATUS_LABEL,
    STATUS_TONE,
    TRANSITIONS,

    // state
    getState: snapshot,
    subscribe,
    loadState,
    initSync,
    setServiceMode,

    // apply (controllers only)
    applySettings,
    applyMotion,
    setApiKeyPresent,
    setPromptDraft,
    setConnectionStatus,
    isConnected,
    setProjects,
    insertProject,
    replaceProject,
    removeProject,
    setProjectFilter,
    setProjectQuery,
    setActiveProject,
    getActiveProject,
    findProjectByRun,
    projectFilters,
    PROJECT_STATUS_ORDER,
    projectNameFromPrompt,

    // build machine
    prepareRun,
    beginRun,
    advanceRun,
    setRunProgress,
    addActivity,
    setRunResult,
    completeRun,
    endRun,
    resetBuild,
    isRunning,
    updateBuild,
    canTransition,
    validateBuildConfig,
  });
})();
