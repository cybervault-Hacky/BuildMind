/* ==========================================================================
   BuildMind — build.js
   The Build workspace.

   The build pipeline below is an explicit timed simulation: it drives the
   activity timeline, the progress component and the world visualizer. No request leaves the browser.

   Public seams for the real implementation:
     startBuild(prompt, config)  -> begins a run
     updateBuildStatus(text)     -> header status pill
     updateBuildProgress(pct)    -> progress bar + label
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const {
    $,
    $$,
    icon,
    sleep,
    clamp,
    toast,
    loadSettings,
    saveSettings,
    BUILD_STAGES,
    findProvider,
    updateWorld,
    mountWorld,
    connectRoblox,
    connectStudio,
    getConnections,
    onStateChange,
  } = BM;

  const state = {
    running: false,
    cancelled: false,
    progress: 0,
    stage: -1,
    startedAt: 0,
  };

  const el = {};

  /* ------------------------------------------------------------------------
     Elements
     ------------------------------------------------------------------------ */
  function cacheElements() {
    el.prompt = $("#game-prompt");
    el.promptCount = $("#prompt-count");
    el.promptClear = $("#prompt-clear");
    el.promptIdea = $("#prompt-idea");
    el.provider = $("#provider");
    el.model = $("#model");
    el.apiKey = $("#api-key");
    el.apiKeyToggle = $("#api-key-toggle");
    el.buildButton = $("#build-button");
    el.buildBar = $(".build-bar");
    el.timeline = $("#build-timeline");
    el.hintTitle = $("#build-hint-title");
    el.hintNote = $("#build-hint-note");
    el.progressStages = $("#progress-stages");
    el.world = $("#build-world");
    el.workspaceStatus = $("#workspace-status");
    el.buildStatus = $("#build-status");
    el.progress = $("#build-progress");
    el.progressBar = $("#progress-bar");
    el.progressFill = $("#progress-fill");
    el.progressValue = $("#progress-value");
    el.progressState = $("#progress-state");
    el.progressTime = $("#progress-time");
    el.robloxStatus = $("#roblox-status");
    el.robloxSub = $("#roblox-sub");
    el.connectRobloxBtn = $("#connect-roblox");
    el.studioStatus = $("#studio-status");
    el.studioSub = $("#studio-sub");
    el.connectStudioBtn = $("#connect-studio");
  }

  /* ------------------------------------------------------------------------
     Timeline
     ------------------------------------------------------------------------ */
  function renderTimeline() {
    if (!el.timeline) return;
    el.timeline.innerHTML = BUILD_STAGES.map(
      (stage, index) => `
        <li class="timeline__step is-pending" data-stage="${index}">
          <span class="timeline__rail"><span class="timeline__dot"></span></span>
          <span class="timeline__label">${stage.label}</span>
          <span class="timeline__meta" data-meta></span>
        </li>`
    ).join("");
  }

  function buildStageMarks() {
    if (!el.progressStages) return;
    el.progressStages.innerHTML = BUILD_STAGES.map(
      (stage) => `<span class="progress__stage" data-mark></span>`
    ).join("");
    el.progressStageMarks = $$("[data-mark]", el.progressStages);
  }

  function paintStageMarks(index) {
    if (!el.progressStageMarks) return;
    const finished = index >= BUILD_STAGES.length - 1;
    el.progressStageMarks.forEach((mark, i) => {
      mark.classList.toggle("is-done", finished || i < index);
      mark.classList.toggle("is-current", !finished && i === index);
    });
  }

  function setStage(index) {
    paintStageMarks(index);
    state.stage = index;
    const steps = $$(".timeline__step", el.timeline);
    steps.forEach((step, i) => {
      step.classList.remove("is-pending", "is-active", "is-done", "is-complete");
      const meta = $("[data-meta]", step);

      if (i < index) {
        step.classList.add(index === BUILD_STAGES.length - 1 ? "is-visited" : "is-done");
        if (meta) meta.textContent = "Done";
      } else if (i === index) {
        step.classList.add(index === BUILD_STAGES.length - 1 ? "is-complete" : "is-active");
        if (meta) meta.textContent = index === BUILD_STAGES.length - 1 ? "Ready" : "Working";
      } else {
        step.classList.add("is-pending");
        if (meta) meta.textContent = "";
      }
    });
  }

  /* ------------------------------------------------------------------------
     Status pill helper
     ------------------------------------------------------------------------ */
  function setStatus(node, text, tone) {
    if (!node) return;
    node.className = `status status--${tone}`;
    const textNode = $(".status__text", node);
    if (textNode) textNode.textContent = text;
    node.classList.add("is-changing");
    window.setTimeout(() => node.classList.remove("is-changing"), 340);
  }

  function setHint(title, note) {
    if (el.hintTitle) el.hintTitle.textContent = title;
    if (el.hintNote) el.hintNote.textContent = note;
  }

  function updateBuildStatus(text) {
    setStatus(el.workspaceStatus, text, toneFor(text));
    setStatus(el.buildStatus, text, toneFor(text));
  }

  function toneFor(text) {
    const t = String(text).toLowerCase();
    if (t === "complete") return "ready";
    if (t === "ready" || t === "stopped") return "idle";
    if (t === "failed" || t === "error") return "error";
    if (t === "fixing") return "warn";
    return "active";
  }

  /* ------------------------------------------------------------------------
     Progress
     ------------------------------------------------------------------------ */
  function updateBuildProgress(value, label) {
    const pct = clamp(Math.round(value), 0, 100);
    state.progress = pct;

    if (el.progressFill) el.progressFill.style.width = `${pct}%`;
    if (el.progressValue) el.progressValue.textContent = `${pct}%`;
    if (el.progressBar) el.progressBar.setAttribute("aria-valuenow", String(pct));
    if (label && el.progressState) el.progressState.textContent = label;

    if (el.progress) {
      el.progress.classList.toggle("is-running", state.running && pct < 100);
      el.progress.classList.toggle("is-complete", pct === 100);
    }

    if (state.running && state.startedAt && el.progressTime) {
      const seconds = Math.round((Date.now() - state.startedAt) / 100) / 10;
      el.progressTime.textContent = `${seconds.toFixed(1)}s`;
    }
  }

  /* ------------------------------------------------------------------------
     Provider / model
     ------------------------------------------------------------------------ */
  function fillModels(providerId, selected) {
    const provider = findProvider(providerId);
    if (!el.model) return;

    el.model.innerHTML = provider.models
      .map((m) => `<option value="${m.id}">${m.label}</option>`)
      .join("");

    const wanted = selected || provider.models[0].id;
    el.model.value = provider.models.some((m) => m.id === wanted)
      ? wanted
      : provider.models[0].id;
  }

  function initProviderControls() {
    const settings = loadSettings();

    el.provider.value = findProvider(settings.provider).id;
    fillModels(el.provider.value, settings.model);

    el.provider.addEventListener("change", () => {
      fillModels(el.provider.value);
      persist();
    });

    el.model.addEventListener("change", persist);

    function persist() {
      saveSettings({ provider: el.provider.value, model: el.model.value });
    }
  }

  /* ------------------------------------------------------------------------
     API key field — UI placeholder only, never sent anywhere
     ------------------------------------------------------------------------ */
  function initApiField() {
    if (!el.apiKey) return;

    BM.bindKeyReveal(el.apiKey, el.apiKeyToggle);

    // Nothing is persisted: a typed key stays in the field only.
    el.apiKey.addEventListener("input", () => {
      el.apiKey.dataset.dirty = "true";
    });
  }

  /* ------------------------------------------------------------------------
     Prompt
     ------------------------------------------------------------------------ */
  const EXAMPLES = [
    "Create a multiplayer survival game on a floating island.",
    "Make an obby with moving platforms, checkpoints and a timer.",
    "Build a tycoon where players buy droppers and expand a base.",
    "Create a round-based arena with classes and a scoreboard.",
  ];

  function initPrompt() {
    if (!el.prompt) return;

    const sync = () => {
      if (el.promptCount) el.promptCount.textContent = String(el.prompt.value.length);
      if (el.promptClear) el.promptClear.hidden = el.prompt.value.length === 0;
    };

    el.prompt.addEventListener("input", sync);
    sync();

    el.promptClear?.addEventListener("click", () => {
      el.prompt.value = "";
      el.prompt.focus();
      sync();
    });

    let exampleIndex = Math.floor(Math.random() * EXAMPLES.length);

    el.promptIdea?.addEventListener("click", () => {
      const text = EXAMPLES[exampleIndex % EXAMPLES.length];
      exampleIndex += 1;
      el.prompt.value = text;
      el.prompt.focus();
      el.prompt.setSelectionRange(text.length, text.length);
      sync();
    });

    $$(".chip[data-idea]").forEach((chip) => {
      chip.addEventListener("click", () => {
        el.prompt.value = chip.dataset.idea || "";
        el.prompt.focus();
        sync();
      });
    });

    // Cmd/Ctrl + Enter starts a build
    el.prompt.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        startBuild(el.prompt.value, readConfig());
      }
    });
  }

  function readConfig() {
    return {
      prompt: el.prompt?.value.trim() || "",
      provider: el.provider?.value || "openai",
      model: el.model?.value || "",
      hasKey: Boolean(el.apiKey?.value.trim()),
      roblox: Boolean(getConnections().roblox.connected),
      studio: Boolean(getConnections().studio.connected),
    };
  }

  /* ------------------------------------------------------------------------
     Connections
     ------------------------------------------------------------------------ */
  function paintConnections() {
    const conns = getConnections();

    if (el.robloxStatus) {
      setStatus(el.robloxStatus, conns.roblox.connected ? "Connected" : "Not connected",
        conns.roblox.connected ? "ready" : "idle");
    }
    if (el.robloxSub) {
      el.robloxSub.textContent = conns.roblox.connected
        ? "Simulated · this session"
        : "Account";
    }
    if (el.connectRobloxBtn) {
      el.connectRobloxBtn.textContent = conns.roblox.connected ? "Disconnect" : "Connect";
      el.connectRobloxBtn.dataset.connected = String(conns.roblox.connected);
      el.connectRobloxBtn.setAttribute(
        "aria-label",
        conns.roblox.connected ? "Disconnect Roblox account" : "Connect Roblox account"
      );
    }

    if (el.studioStatus) {
      setStatus(el.studioStatus, conns.studio.connected ? "Connected" : "Not connected",
        conns.studio.connected ? "ready" : "idle");
    }
    if (el.studioSub) {
      el.studioSub.textContent = conns.studio.connected
        ? "Simulated · this session"
        : "Local bridge";
    }
    if (el.connectStudioBtn) {
      el.connectStudioBtn.textContent = conns.studio.connected ? "Disconnect" : "Connect";
      el.connectStudioBtn.dataset.connected = String(conns.studio.connected);
      el.connectStudioBtn.setAttribute(
        "aria-label",
        conns.studio.connected ? "Disconnect Roblox Studio" : "Connect Roblox Studio"
      );
    }
  }

  async function handleConnectRoblox() {
    const button = el.connectRobloxBtn;
    if (getConnections().roblox.connected) {
      BM.disconnectRoblox();
      toast("Roblox disconnected");
      return;
    }
    button?.classList.add("is-loading");
    await connectRoblox();
    button?.classList.remove("is-loading");
    toast("Roblox connection simulated");
  }

  async function handleConnectStudio() {
    const button = el.connectStudioBtn;
    if (getConnections().studio.connected) {
      BM.disconnectStudio();
      toast("Studio disconnected");
      return;
    }
    button?.classList.add("is-loading");
    await connectStudio();
    button?.classList.remove("is-loading");
    toast("Studio bridge simulated");
  }

  /* ------------------------------------------------------------------------
     The simulated build
     ------------------------------------------------------------------------ */
  const SCRIPT = [
    { stage: 0, target: 8, ms: 1100, status: "Understanding" },
    { stage: 1, target: 18, ms: 1400, status: "Planning" },
    { stage: 2, target: 56, ms: 2600, status: "Building" },
    { stage: 3, target: 78, ms: 2000, status: "Testing" },
    // Fixing holds the bar while the agent repairs — progress never goes back.
    { stage: 4, target: 78, ms: 1700, status: "Fixing" },
    { stage: 5, target: 94, ms: 1400, status: "Validating" },
    { stage: 6, target: 100, ms: 900, status: "Complete" },
  ];

  /** Advance the progress value smoothly toward a target. */
  function animateProgressTo(target, ms) {
    return new Promise((resolve) => {
      const from = state.progress;
      const duration = Math.max(120, ms);

      if (target === from) {
        window.setTimeout(resolve, duration);
        return;
      }

      const start = performance.now();

      const frame = (now) => {
        if (state.cancelled) return resolve();
        const t = clamp((now - start) / duration, 0, 1);
        // easeOutCubic so the bar settles rather than stopping dead
        const eased = 1 - Math.pow(1 - t, 3);
        updateBuildProgress(from + (target - from) * eased);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  function resetBuildUI() {
    if (!el.progress) return;
    state.cancelled = false;
    state.running = false;
    state.startedAt = 0;
    state.stage = -1;

    if (el.progressStageMarks) {
      el.progressStageMarks.forEach((mark) => mark.classList.remove("is-done", "is-current"));
    }
    if (el.progress) el.progress.classList.remove("is-running", "is-complete");
    if (el.progressTime) el.progressTime.textContent = "—";
    updateBuildProgress(0, "Ready");
    setStage(-1);
    if (el.timeline) {
      $$(".timeline__step", el.timeline).forEach((step) => {
        step.classList.remove("is-done", "is-active", "is-complete", "is-visited");
        step.classList.add("is-pending");
      });
    }
    updateWorld(el.world, { state: "idle", progress: 0 });
  }

  /**
   * startBuild — the single entry point for a build.
   * The agent call will replace the body of runSimulation later.
   */
  async function startBuild(prompt, config) {
    if (state.running) return;

    if (!prompt) {
      if (el.prompt) {
        el.prompt.focus();
        el.prompt.closest(".prompt-block")?.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-4px)" },
            { transform: "translateX(4px)" },
            { transform: "translateX(0)" },
          ],
          { duration: 220, easing: "ease-in-out" }
        );
      }
      return;
    }

    resetBuildUI();

    state.running = true;
    state.cancelled = false;
    state.startedAt = Date.now();

    if (config.hasKey) {
      // Deliberately never stored or transmitted.
      el.apiKey.value = "";
      el.apiKey.type = "password";
      el.apiKeyToggle?.setAttribute("aria-pressed", "false");
      el.apiKeyToggle?.setAttribute("aria-label", "Show API key");
      el.apiKeyToggle?.querySelectorAll(".icon-eye").forEach((n) => n.removeAttribute("hidden"));
      const eyeOff = el.apiKeyToggle?.querySelector(".icon-eye-off");
      if (eyeOff) eyeOff.classList.add("is-off");
    }

    setBuildingUi(true);

    const outcome = await runSimulation();

    setBuildingUi(false, outcome);
  }

  /**
   * Swap the primary action between "Build Game" and "Stop".
   * @param {boolean} building
   * @param {"idle"|"complete"|"stopped"} outcome used for the hint once the run ends
   */
  function setBuildingUi(building, outcome = "idle") {
    if (!el.buildButton) return;

    el.buildButton.classList.toggle("btn--primary", !building);
    el.buildButton.classList.toggle("btn--ghost", building);
    el.buildButton.innerHTML = building
      ? `${icon("stop")}<span>Stop build</span>`
      : "Build Game";
    el.buildButton.setAttribute("aria-busy", String(building));
    el.buildButton.setAttribute(
      "aria-label",
      building ? "Stop the running build" : "Build the described game"
    );

    if (building) {
      setHint("Building", "Simulated run — stop any time");
      el.prompt.setAttribute("readonly", "");
      el.buildBar?.classList.add("is-running");
      return;
    }

    el.prompt.removeAttribute("readonly");
    el.buildBar?.classList.remove("is-running");

    if (outcome === "complete") {
      setHint("Build complete", "Simulated result — nothing was published");
    } else if (outcome === "stopped") {
      setHint("Stopped", "Nothing was published");
    } else {
      setHint("Ready to build", "Simulated — nothing leaves your browser");
    }
  }

  async function runSimulation() {
    for (let i = 0; i < SCRIPT.length; i += 1) {
      if (state.cancelled) return "stopped";

      const step = SCRIPT[i];
      setStage(step.stage);
      updateBuildStatus(step.status);

      updateWorld(el.world, {
        state:
          i === 3 ? "testing" : i === 4 ? "fixing" : i === 6 ? "complete" : "building",
        progress: step.target,
      });

      if (i === SCRIPT.length - 1) {
        if (el.progress) el.progress.classList.remove("is-running");
        updateBuildProgress(100, "Complete");
        updateBuildStatus("Complete");
        await sleep(step.ms);
        break;
      }

      await animateProgressTo(step.target, step.ms - 140);
      await sleep(140);
    }

    if (state.cancelled) return "stopped";

    state.running = false;
    updateBuildStatus("Complete");
    updateBuildProgress(100, "Complete");
    if (el.progressTime) {
      const seconds = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      el.progressTime.textContent = `${seconds}s`;
    }
    updateWorld(el.world, { state: "complete", progress: 100 });
    toast("Build complete — simulated");
    return "complete";
  }

  function initBuildButton() {
    if (!el.buildButton) return;
    el.buildButton.hidden = false;

    el.buildButton.addEventListener("click", () => {
      if (state.running) {
        state.cancelled = true;
        state.running = false;
        setBuildingUi(false, "stopped");
        updateBuildStatus("Stopped");
        if (el.progressState) el.progressState.textContent = "Stopped";
        if (el.progress) el.progress.classList.remove("is-running");
        toast("Build stopped");
        return;
      }
      startBuild(el.prompt.value.trim(), readConfig());
    });
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    cacheElements();
    renderTimeline();
    buildStageMarks();
    mountWorld(el.world);
    resetBuildUI();
    initProviderControls();
    initApiField();
    initPrompt();
    BM.restoreConnections(BM.readStore("buildmind.connections.v1", {}));
    paintConnections();
    initBuildButton();

    onStateChange((type) => {
      if (type !== "connection") return;
      paintConnections();
      BM.writeStore("buildmind.connections.v1", BM.snapshotConnections());
    });

    el.connectRobloxBtn?.addEventListener("click", handleConnectRoblox);
    el.connectStudioBtn?.addEventListener("click", handleConnectStudio);

    // Deep link: build.html?prompt=... prefills the composer
    const params = new URLSearchParams(window.location.search);
    const preset = params.get("prompt");
    if (preset && el.prompt) {
      el.prompt.value = preset;
      el.prompt.dispatchEvent(new Event("input"));
    }

    // Expose the seams for later phases and for manual testing.
    Object.assign(BM, {
      startBuild,
      updateBuildStatus,
      updateBuildProgress,
      connectRoblox: handleConnectRoblox,
      connectStudio: handleConnectStudio,
      buildState: state,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
