/* ==========================================================================
   BuildMind — state.js
   The single frontend state model for the product.

   Everything the UI needs lives in `state` below: settings, motion preference,
   connection status, the build state machine, projects and the active project
   filter. Pages never keep their own copies — they subscribe and render.

   Nothing here talks to a network. Connections, builds and project creation
   are all local simulations. The API key is never persisted, never sent and
   never logged: only an `apiKeyPresent` boolean exists, in memory.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});
  const { readStore, writeStore, clamp } = BM;

  /* ------------------------------------------------------------------------
     Storage keys — settings, motion and connections are shared across pages,
     projects are stored separately, keys are never stored at all.
     ------------------------------------------------------------------------ */
  const KEYS = {
    settings: "buildmind.settings.v1",
    preferences: "buildmind.preferences.v1",
    connections: "buildmind.connections.v1",
    projects: "buildmind.projects.v1",
  };

  const SETTINGS_DEFAULTS = {
    provider: "openai",
    model: "gpt-4.1",
    autoFix: true,
    hints: true,
  };

  /* ------------------------------------------------------------------------
     AI provider catalogue — UI data only. Phase 3 never calls a provider.
     ------------------------------------------------------------------------ */
  const PROVIDERS = [
    {
      id: "openai",
      label: "OpenAI",
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
      requiresKey: true,
      models: [
        { id: "gemini-2-5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2-5-flash", label: "Gemini 2.5 Flash" },
      ],
    },
    {
      id: "xai",
      label: "xAI",
      requiresKey: true,
      models: [{ id: "grok-4", label: "Grok 4" }],
    },
  ];

  function findProvider(id) {
    return PROVIDERS.find((provider) => provider.id === id) || PROVIDERS[0];
  }

  /* ------------------------------------------------------------------------
     Build stages — one definition, used by the timeline, the stage markers,
     the progress component and the runner.
     ------------------------------------------------------------------------ */
  const BUILD_STAGES = [
    { id: "understand", label: "Understanding idea", status: "building", progress: 8, ms: 1100 },
    { id: "plan", label: "Planning", status: "building", progress: 18, ms: 1400 },
    { id: "build", label: "Building", status: "building", progress: 56, ms: 2600 },
    { id: "test", label: "Testing", status: "testing", progress: 78, ms: 2000 },
    { id: "fix", label: "Fixing", status: "fixing", progress: 78, ms: 1700 },
    { id: "validate", label: "Validating", status: "validating", progress: 94, ms: 1400 },
    { id: "complete", label: "Complete", status: "complete", progress: 100, ms: 900 },
  ];

  const LAST_STAGE = BUILD_STAGES.length - 1;

  /* ------------------------------------------------------------------------
     Build state machine.
     A transition is only applied when it appears in this table, so the UI can
     never show two contradictory states at once.
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
    fixing: [BUILD.VALIDATING, BUILD.STOPPED, BUILD.ERROR],
    validating: [BUILD.COMPLETE, BUILD.STOPPED, BUILD.ERROR],
    complete: [BUILD.READY, BUILD.BUILDING],
    stopped: [BUILD.READY, BUILD.BUILDING],
    error: [BUILD.READY, BUILD.BUILDING],
  };

  /** Human labels used by the status pills and the live region. */
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

  /** Status pill tone for each state. */
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

  function statusForStage(index) {
    const stage = BUILD_STAGES[index];
    return stage ? stage.status : BUILD.READY;
  }

  /* ------------------------------------------------------------------------
     Project status vocabulary (shared by the cards and the filters).
     ------------------------------------------------------------------------ */
  const PROJECT_STATUS = {
    ready: { label: "Ready", tone: "ready" },
    building: { label: "Building", tone: "active" },
    complete: { label: "Complete", tone: "ready" },
    draft: { label: "Draft", tone: "idle" },
  };

  const SCENE_ARTS = ["lattice", "terrain", "graph", "plates", "dots", "arcs"];

  /* ------------------------------------------------------------------------
     Seed projects — clearly local sample data.
     ------------------------------------------------------------------------ */
  const SAMPLE_PROJECTS = [
    { id: "sample-island", name: "Floating Island Survival", status: "ready", updated: "2 days ago", art: "lattice", scene: 0, sample: true },
    { id: "sample-obby", name: "Checkpoint Obby", status: "building", updated: "5 hours ago", art: "terrain", scene: 1, sample: true },
    { id: "sample-tycoon", name: "Dropper Tycoon", status: "ready", updated: "1 week ago", art: "graph", scene: 2, sample: true },
    { id: "sample-arena", name: "Round-Based Arena", status: "draft", updated: "3 weeks ago", art: "plates", scene: 3, sample: true },
  ];

  /* ------------------------------------------------------------------------
     The store
     ------------------------------------------------------------------------ */
  const state = {
    page: document.body ? document.body.dataset.page || "" : "",
    settings: { ...SETTINGS_DEFAULTS },
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
      runId: 0,
      startedAt: 0,
      endedAt: 0,
      error: "",
    },
    projects: [],
    projectsFilter: "all",
  };

  const listeners = new Set();
  let persistTimer = 0;

  function snapshot() {
    return {
      ...state,
      settings: { ...state.settings },
      connections: {
        roblox: { ...state.connections.roblox },
        studio: { ...state.connections.studio },
      },
      build: { ...state.build },
      projects: state.projects.slice(),
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

  /** Commit a partial update. `changed` lists the slices that moved. */
  function commit(patch, changed) {
    Object.assign(state, patch);
    notify(changed);
    if (changed.some((key) => key !== "build" && key !== "projectsFilter")) schedulePersist();
  }

  function schedulePersist() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persist, 60);
  }

  function persist() {
    writeStore(KEYS.settings, state.settings);
    writeStore(KEYS.preferences, { motion: state.motion });
    writeStore(KEYS.connections, {
      roblox: state.connections.roblox.status === "connected",
      studio: state.connections.studio.status === "connected",
    });
    try {
      window.localStorage.setItem(KEYS.projects, JSON.stringify(state.projects));
    } catch (err) {
      /* storage unavailable: state stays in memory only */
    }
  }

  /* ------------------------------------------------------------------------
     Loading
     ------------------------------------------------------------------------ */
  function loadState() {
    const settings = readStore(KEYS.settings, SETTINGS_DEFAULTS);
    const provider = findProvider(settings.provider);
    const model = provider.models.some((m) => m.id === settings.model)
      ? settings.model
      : provider.models[0].id;

    state.settings = {
      provider: provider.id,
      model,
      autoFix: settings.autoFix !== false,
      hints: settings.hints !== false,
    };

    const prefs = readStore(KEYS.preferences, { motion: "full" });
    state.motion = prefs.motion === "reduced" ? "reduced" : "full";

    const conns = readStore(KEYS.connections, {});
    state.connections.roblox.status = conns.roblox ? "connected" : "disconnected";
    state.connections.studio.status = conns.studio ? "connected" : "disconnected";

    // Projects: an existing list is respected as-is, even when it is empty.
    // Samples only seed a first-time visitor.
    const stored = readRawArray(KEYS.projects);
    state.projects = stored ? stored.filter(isValidProject) : SAMPLE_PROJECTS.slice();

    state.apiKeyPresent = false;
    return snapshot();
  }

  /** Arrays are stored and read as-is; readStore() merges plain objects.
      Returns null when nothing has been stored yet. */
  function readRawArray(key) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function isValidProject(project) {
    return (
      project &&
      typeof project.id === "string" &&
      typeof project.name === "string" &&
      typeof project.status === "string" &&
      PROJECT_STATUS[project.status]
    );
  }

  /* ------------------------------------------------------------------------
     Settings actions
     ------------------------------------------------------------------------ */
  function setProvider(id) {
    const provider = findProvider(id);
    if (provider.id === state.settings.provider) return;

    // A model always belongs to the provider that is selected.
    state.settings = {
      ...state.settings,
      provider: provider.id,
      model: provider.models[0].id,
    };
    commit({ settings: state.settings }, ["settings"]);
  }

  function setModel(id) {
    const provider = findProvider(state.settings.provider);
    if (!provider.models.some((model) => model.id === id)) return;
    if (id === state.settings.model) return;

    state.settings = { ...state.settings, model: id };
    commit({ settings: state.settings }, ["settings"]);
  }

  function setPreference(key, value) {
    if (!(key in SETTINGS_DEFAULTS) || ["provider", "model"].includes(key)) return;

    state.settings = { ...state.settings, [key]: Boolean(value) };
    commit({ settings: state.settings }, ["settings"]);
  }

  function setMotion(mode) {
    const next = mode === "reduced" ? "reduced" : "full";
    if (next === state.motion) return;

    BM.applyMotionPreference(next);
    commit({ motion: next }, ["motion"]);
  }

  function resetSettings() {
    const provider = findProvider(SETTINGS_DEFAULTS.provider);
    state.settings = { ...SETTINGS_DEFAULTS, model: provider.models[0].id };
    state.motion = "full";
    BM.applyMotionPreference("full");
    commit({ settings: state.settings, motion: state.motion }, ["settings", "motion"]);
  }

  /**
   * The key itself is never stored — only whether one is present.
   * @param {boolean} present
   */
  function setApiKeyPresent(present) {
    const next = Boolean(present);
    if (next === state.apiKeyPresent) return;
    commit({ apiKeyPresent: next }, ["apiKeyPresent"]);
  }

  /* ------------------------------------------------------------------------
     Connection actions — simulated, with an honest `connecting` phase.
     ------------------------------------------------------------------------ */
  const CONNECT_DELAY = { roblox: 800, studio: 1100 };

  function setConnectionStatus(target, status) {
    if (!state.connections[target]) return;
    state.connections = {
      ...state.connections,
      [target]: { ...state.connections[target], status },
    };
    commit({ connections: state.connections }, ["connections"]);
  }

  async function connect(target) {
    const connection = state.connections[target];
    if (!connection || connection.status !== "disconnected") return pendingConnect(target);

    setConnectionStatus(target, "connecting");
    await new Promise((resolve) => window.setTimeout(resolve, CONNECT_DELAY[target] || 800));
    setConnectionStatus(target, "connected");
    return true;
  }

  function pendingConnect(target) {
    return state.connections[target].status === "connected";
  }

  function disconnect(target) {
    if (!state.connections[target]) return;
    setConnectionStatus(target, "disconnected");
  }

  function connectRoblox() {
    return connect("roblox");
  }

  function connectStudio() {
    return connect("studio");
  }

  function disconnectRoblox() {
    disconnect("roblox");
  }

  function disconnectStudio() {
    disconnect("studio");
  }

  function isConnected(target) {
    return state.connections[target].status === "connected";
  }

  /* ------------------------------------------------------------------------
     Projects
     ------------------------------------------------------------------------ */
  function loadProjects() {
    // In a later phase this becomes a fetch; the call signature stays the same.
    if (readRawArray(KEYS.projects) === null && !state.projects.length) {
      state.projects = SAMPLE_PROJECTS.slice();
    }
    notify(["projects"]);
    return state.projects.slice();
  }

  function setProjectFilter(filter) {
    if (filter === state.projectsFilter) return;
    commit({ projectsFilter: filter }, ["projectsFilter"]);
  }

  function projectFilters() {
    // Filters are derived from the statuses that actually exist, so no filter
    // can lead to a dead end.
    const present = new Set(state.projects.map((project) => project.status));
    const order = ["ready", "building", "complete", "draft"];
    return [
      { id: "all", label: "All" },
      ...order.filter((status) => present.has(status)).map((status) => ({
        id: status,
        label: PROJECT_STATUS[status].label,
      })),
    ];
  }

  const NAME_FILLER = new Set([
    "a", "an", "the", "with", "and", "for", "of", "on", "in", "to", "where", "that",
    "players", "player", "game", "games", "map", "level", "mode",
  ]);

  const NAME_SCENE_WORDS = new Set(["survival", "obby", "tycoon", "arena", "racing", "horror"]);

  /** Turn a prompt into a short project title, e.g. "Floating Island Survival". */
  function projectNameFromPrompt(prompt) {
    const cleaned = String(prompt || "")
      .replace(/^(please\s+)?(create|make|build|design|generate)\s+/i, "")
      .replace(/^(a|an|the)\s+/i, "")
      .replace(/[.!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return "Untitled game";

    const words = cleaned
      .split(" ")
      .map((word) => word.replace(/[^\w'-]/g, ""))
      .filter(Boolean);

    const picked = words
      .filter((word) => !NAME_FILLER.has(word.toLowerCase()) && !NAME_SCENE_WORDS.has(word.toLowerCase()))
      .slice(0, 2);
    const scene = words.find((word) => NAME_SCENE_WORDS.has(word.toLowerCase()));

    const parts = (picked.length ? picked : words.slice(0, 2));
    if (scene && !parts.includes(scene)) parts.push(scene);

    // Title-case each word so "floating island" reads like a project name.
    const title = parts
      .slice(0, 3)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return title || "Untitled game";
  }

  function artForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    return { art: SCENE_ARTS[hash % SCENE_ARTS.length], scene: hash % 6 };
  }

  /**
   * Represent the result of a finished simulated build as a project entry.
   * This is local mock data: no real game is created or published.
   */
  function addProjectFromBuild(prompt) {
    const name = projectNameFromPrompt(prompt);
    const art = artForName(name);
    const existing = state.projects.find((project) => project.name === name);

    if (existing) {
      state.projects = state.projects.map((project) =>
        project.id === existing.id
          ? { ...project, status: "complete", updated: "Just now", simulated: true }
          : project
      );
    } else {
      state.projects = [
        {
          id: `local-${Date.now().toString(36)}`,
          name,
          status: "complete",
          updated: "Just now",
          art: art.art,
          scene: art.scene,
          simulated: true,
        },
        ...state.projects,
      ];
    }

    commit({ projects: state.projects }, ["projects"]);
    return name;
  }

  /* ------------------------------------------------------------------------
     Build state machine + simulated runner
     ------------------------------------------------------------------------ */
  let stageTimer = 0;
  let pendingWait = null;

  function isRunning(build) {
    return RUNNING_STATUSES.includes((build || state.build).status);
  }

  function canTransition(from, to) {
    return (TRANSITIONS[from] || []).includes(to);
  }

  /** Apply a build patch only when the status move is legal. */
  function updateBuild(patch) {
    const next = { ...state.build, ...patch };

    if (patch.status && patch.status !== state.build.status) {
      if (!canTransition(state.build.status, patch.status)) {
        console.warn(
          `[BuildMind] blocked build transition ${state.build.status} → ${patch.status}`
        );
        return false;
      }
    }

    state.build = next;
    commit({ build: state.build }, ["build"]);
    return true;
  }

  function clearWait() {
    window.clearTimeout(stageTimer);
    stageTimer = 0;
    if (pendingWait) {
      const resolve = pendingWait;
      pendingWait = null;
      resolve();
    }
  }

  function wait(ms) {
    return new Promise((resolve) => {
      pendingWait = resolve;
      stageTimer = window.setTimeout(() => {
        pendingWait = null;
        stageTimer = 0;
        resolve();
      }, ms);
    });
  }

  /**
   * Start a simulated build.
   * The agent call will replace the body of this runner later; the call
   * signature and the state machine stay the same.
   */
  async function startBuild(prompt) {
    if (isRunning()) return false;

    const text = String(prompt || "").trim();
    if (!text) return false;

    clearWait();

    const runId = state.build.runId + 1;
    state.build = {
      status: BUILD.READY,
      stage: -1,
      progress: 0,
      prompt: text,
      runId,
      startedAt: 0,
      endedAt: 0,
      error: "",
    };
    commit({ build: state.build }, ["build"]);

    if (!updateBuild({ status: BUILD.BUILDING, startedAt: Date.now() })) return false;

    // A run is alive while it is still the current run and has not ended.
    const alive = () =>
      state.build.runId === runId &&
      !TERMINAL_STATUSES.includes(state.build.status);

    // Every stage except the final one advances the state machine.
    for (let index = 0; index < LAST_STAGE; index += 1) {
      if (!alive()) return false;

      const stage = BUILD_STAGES[index];
      updateBuild({
        stage: index,
        progress: stage.progress,
        status: statusForStage(index),
      });

      await wait(stage.ms);
    }

    if (!alive()) return false;

    // The last stage is only reached by finishing, never by a loop tick.
    updateBuild({
      stage: LAST_STAGE,
      progress: 100,
      status: BUILD.COMPLETE,
      endedAt: Date.now(),
    });

    // Finishing a run is the only place a project is produced.
    addProjectFromBuild(text);
    return true;
  }

  function stopBuild() {
    if (!isRunning()) return false;

    state.build.runId += 1;
    clearWait();
    updateBuild({ status: BUILD.STOPPED, endedAt: Date.now() });
    return true;
  }

  /** Simulated failure — used to prove the UI can recover. */
  function failBuild(reason) {
    if (!isRunning()) return false;

    state.build.runId += 1;
    clearWait();
    updateBuild({
      status: BUILD.ERROR,
      endedAt: Date.now(),
      error: reason || "The simulated run stopped unexpectedly.",
    });
    return true;
  }

  /** Retry after a failure or a stop: full reset, then a fresh run. */
  function retryBuild() {
    if (isRunning()) return false;
    const prompt = state.build.prompt;
    resetBuild();
    return startBuild(prompt);
  }

  function resetBuild() {
    clearWait();
    state.build = {
      status: BUILD.READY,
      stage: -1,
      progress: 0,
      prompt: state.build.prompt,
      runId: state.build.runId + 1,
      startedAt: 0,
      endedAt: 0,
      error: "",
    };
    commit({ build: state.build }, ["build"]);
  }

  /* ------------------------------------------------------------------------
     Validation — frontend configuration only, nothing is verified remotely.
     ------------------------------------------------------------------------ */
  function validateBuildConfig({ prompt, apiKey }) {
    const errors = {};
    const text = String(prompt || "").trim();

    if (!text) errors.prompt = "Describe the game you want to build.";
    else if (text.length < 8) errors.prompt = "A little more detail, at least a sentence.";

    const provider = findProvider(state.settings.provider);
    if (!provider) errors.provider = "Choose an AI provider.";
    else if (!provider.models.some((model) => model.id === state.settings.model)) {
      errors.model = "Choose a model for this provider.";
    }

    // Presence only. Phase 3 never verifies or transmits the key.
    const hasKey = Boolean(apiKey && apiKey.trim()) || state.apiKeyPresent;
    if (provider && provider.requiresKey && !hasKey) {
      errors.apiKey = "Enter a key to run a build. It is never stored or sent.";
    }

    return { valid: Object.keys(errors).length === 0, errors };
  }

  /* ------------------------------------------------------------------------
     Cross-page / cross-tab synchronisation
     ------------------------------------------------------------------------ */
  function initSync() {
    window.addEventListener("storage", (event) => {
      if (!event.key) return;

      if (event.key === KEYS.settings || event.key === KEYS.preferences) {
        loadState();
        BM.applyMotionPreference(state.motion);
        notify(["settings", "motion"]);
      } else if (event.key === KEYS.connections) {
        const conns = readStore(KEYS.connections, {});
        state.connections.roblox.status = conns.roblox ? "connected" : "disconnected";
        state.connections.studio.status = conns.studio ? "connected" : "disconnected";
        notify(["connections"]);
      } else if (event.key === KEYS.projects) {
        const stored = readRawArray(KEYS.projects);
        if (stored) {
          state.projects = stored.filter(isValidProject);
          notify(["projects"]);
        }
      }
    });
  }

  /* ------------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------------ */
  Object.assign(BM, {
    KEYS,
    PROVIDERS,
    BUILD_STAGES,
    PROJECT_STATUS,
    BUILD,
    RUNNING_STATUSES,
    TERMINAL_STATUSES,
    STATUS_LABEL,
    STATUS_TONE,
    statusForStage,
    findProvider,

    // state
    getState: snapshot,
    subscribe,
    loadState,
    initSync,

    // settings
    setProvider,
    setModel,
    setPreference,
    setMotion,
    resetSettings,
    setApiKeyPresent,

    // connections
    connectRoblox,
    disconnectRoblox,
    connectStudio,
    disconnectStudio,
    isConnected,

    // projects
    loadProjects,
    setProjectFilter,
    projectFilters,
    addProjectFromBuild,
    projectNameFromPrompt,

    // build
    startBuild,
    stopBuild,
    failBuild,
    retryBuild,
    resetBuild,
    isRunning,
    validateBuildConfig,
  });
})();
