/* ==========================================================================
   BuildMind — build.js
   The Build workspace.

   This file is a renderer only. It reads state, paints the timeline, progress,
   connections and action bar, and forwards user intent to the controllers:

     build intent        → BM.buildController
     connection toggles  → BM.connectionController
     provider/model      → BM.settingsController

   No build logic, provider list, connection simulation or persistence lives
   here. Everything remains simulated; the API key is only checked for
   presence and is handed to the controller in memory.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const {
    $,
    $$,
    icon,
    toast,
    BUILD_STAGES,
    BUILD,
    STATUS_LABEL,
    STATUS_TONE,
    RUNNING_STATUSES,
    getState,
    subscribe,
    setApiKeyPresent,
    setPromptDraft,
    mountWorld,
    updateWorld,
  } = BM;

  const providerList = () => BM.providerCatalog.list();
  const providerFor = (id) => BM.providerCatalog.resolve(id);

  const el = {};
  const local = {
    exampleIndex: Math.floor(Math.random() * 4),
    lastRunId: -1,
  };

  const EXAMPLES = [
    "Create a multiplayer survival game on a floating island.",
    "Make an obby with moving platforms, checkpoints and a timer.",
    "Build a tycoon where players buy droppers and expand a base.",
    "Create a round-based arena with classes and a scoreboard.",
  ];

  /* ------------------------------------------------------------------------
     Elements
     ------------------------------------------------------------------------ */
  function cacheElements() {
    el.prompt = $("#game-prompt");
    el.promptBlock = $(".prompt-block");
    el.promptCount = $("#prompt-count");
    el.promptClear = $("#prompt-clear");
    el.promptIdea = $("#prompt-idea");
    el.provider = $("#provider");
    el.model = $("#model");
    el.apiKey = $("#api-key");
    el.apiKeyToggle = $("#api-key-toggle");
    el.buildButton = $("#build-button");
    el.buildBar = $(".build-bar");
    el.hintTitle = $("#build-hint-title");
    el.hintNote = $("#build-hint-note");
    el.timeline = $("#build-timeline");
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
    el.live = $("#build-live");
    el.robloxRow = $("#roblox-row");
    el.robloxStatus = $("#roblox-status");
    el.robloxSub = $("#roblox-sub");
    el.connectRobloxBtn = $("#connect-roblox");
    el.studioRow = $("#studio-row");
    el.studioStatus = $("#studio-status");
    el.studioSub = $("#studio-sub");
    el.connectStudioBtn = $("#connect-studio");
  }

  /* ------------------------------------------------------------------------
     Small render helpers
     ------------------------------------------------------------------------ */
  function setStatus(node, text, tone) {
    if (!node) return;
    const changed = node.className !== `status status--${tone}`;
    node.className = `status status--${tone}`;
    const label = $(".status__text", node);
    if (label) label.textContent = text;
    if (changed) {
      node.classList.add("is-changing");
      window.setTimeout(() => node.classList.remove("is-changing"), 340);
    }
  }

  function announce(message) {
    if (!el.live) return;
    // Re-assigning the same text would not be announced again.
    el.live.textContent = "";
    requestAnimationFrame(() => {
      el.live.textContent = message;
    });
  }

  function setFieldError(name, message) {
    const field = $(`[data-field="${name}"]`);
    const error = $(`#${name}-error`);
    if (!field || !error) return;

    const input = $("input, textarea, select", field);
    field.classList.toggle("has-error", Boolean(message));
    error.textContent = message || "";
    error.hidden = !message;
    if (message) {
      input?.setAttribute("aria-invalid", "true");
      input?.setAttribute("aria-describedby", `${name}-error`);
    } else {
      input?.removeAttribute("aria-invalid");
    }
  }

  function clearErrors() {
    ["prompt", "apiKey", "provider", "model"].forEach((name) => setFieldError(name, ""));
  }

  /* ------------------------------------------------------------------------
     Timeline
     ------------------------------------------------------------------------ */
  function renderTimeline() {
    if (!el.timeline) return;

    el.timeline.innerHTML = BUILD_STAGES.map(
      (stage, index) => `
        <li class="timeline__step" data-stage="${index}">
          <span class="timeline__rail"><span class="timeline__dot"></span></span>
          <span class="timeline__label">${stage.label}</span>
          <span class="timeline__meta" data-meta></span>
        </li>`
    ).join("");

    el.steps = $$(".timeline__step", el.timeline);
  }

  function renderStageMarks() {
    if (!el.progressStages) return;
    el.progressStages.innerHTML = BUILD_STAGES.map(
      () => `<span class="progress__stage" data-mark></span>`
    ).join("");
    el.marks = $$("[data-mark]", el.progressStages);
  }

  function paintTimeline(build) {
    if (!el.steps) return;

    const { status, stage } = build;
    const finished = status === BUILD.COMPLETE;
    const failed = status === BUILD.ERROR;
    const current = RUNNING_STATUSES.includes(status) ? stage : -1;

    el.steps.forEach((step, i) => {
      step.classList.remove("is-pending", "is-active", "is-done", "is-complete", "is-visited");

      const meta = $("[data-meta]", step);
      if (meta) meta.textContent = "";

      if (finished) {
        step.classList.add(i === stage ? "is-complete" : "is-done");
        if (meta) meta.textContent = i === stage ? "Ready" : "Done";
        return;
      }

      if (failed && i === stage) {
        step.classList.add("is-failed");
        if (meta) meta.textContent = "Failed";
        return;
      }

      if (current === -1) {
        step.classList.add("is-pending");
        return;
      }

      if (i < current) {
        step.classList.add("is-done");
        if (meta) meta.textContent = "Done";
      } else if (i === current) {
        step.classList.add("is-active");
        if (meta) meta.textContent = "Working";
      } else {
        step.classList.add("is-pending");
      }
    });
  }

  function paintStageMarks(build) {
    if (!el.marks) return;

    const { status, stage } = build;
    const finished = status === BUILD.COMPLETE;
    const current = RUNNING_STATUSES.includes(status) ? stage : -1;

    el.marks.forEach((mark, i) => {
      mark.classList.toggle("is-done", finished || (current > -1 && i < current));
      mark.classList.toggle("is-current", current > -1 && i === current);
    });

    if (el.progress) el.progress.classList.toggle("is-complete", finished);
  }

  /* ------------------------------------------------------------------------
     Progress
     ------------------------------------------------------------------------ */
  function paintProgress(build) {
    const pct = Math.max(0, Math.min(100, Math.round(build.progress)));

    if (el.progressFill) el.progressFill.style.width = `${pct}%`;
    if (el.progressValue) el.progressValue.textContent = `${pct}%`;
    if (el.progressBar) el.progressBar.setAttribute("aria-valuenow", String(pct));

    const running = RUNNING_STATUSES.includes(build.status);
    if (el.progress) el.progress.classList.toggle("is-running", running);

    if (el.progressState) el.progressState.textContent = STATUS_LABEL[build.status];

    if (el.progressTime) {
      if (build.status === BUILD.READY) el.progressTime.textContent = "—";
      else if (build.endedAt && build.startedAt) {
        el.progressTime.textContent = `${((build.endedAt - build.startedAt) / 1000).toFixed(1)}s`;
      } else if (build.startedAt) {
        el.progressTime.textContent = `${((Date.now() - build.startedAt) / 1000).toFixed(1)}s`;
      }
    }
  }

  function paintStatusPills(build) {
    const label = STATUS_LABEL[build.status];
    const tone = STATUS_TONE[build.status];
    setStatus(el.workspaceStatus, label, tone);
    setStatus(el.buildStatus, label, tone);
  }

  /* ------------------------------------------------------------------------
     Action bar
     ------------------------------------------------------------------------ */
  const HINTS = {
    ready: ["Ready to build", "Simulated — nothing leaves your browser"],
    building: ["Building", "Simulated run — stop any time"],
    testing: ["Testing", "Simulated run — stop any time"],
    fixing: ["Fixing", "Repairing simulated issues"],
    validating: ["Validating", "Simulated run — stop any time"],
    complete: ["Build complete", "Added to Projects — simulated, nothing published"],
    stopped: ["Stopped", "Nothing was published — start again any time"],
    error: ["Something went wrong", "The simulated run failed — try again"],
  };

  function paintAction(build) {
    if (!el.buildButton) return;

    const running = RUNNING_STATUSES.includes(build.status);
    const hint = HINTS[build.status] || HINTS.ready;

    // Primary action label follows the state machine.
    let label = "Build Game";
    let iconName = "";
    if (running) {
      label = "Stop build";
      iconName = icon("stop");
    } else if (build.status === BUILD.COMPLETE) {
      label = "Build again";
    } else if (build.status === BUILD.STOPPED) {
      label = "Start again";
    } else if (build.status === BUILD.ERROR) {
      label = "Try again";
    }

    el.buildButton.classList.toggle("btn--primary", !running);
    el.buildButton.classList.toggle("btn--ghost", running);
    el.buildButton.innerHTML = `${iconName}<span>${label}</span>`;
    el.buildButton.setAttribute("aria-busy", String(running));
    el.buildButton.setAttribute(
      "aria-label",
      running ? "Stop the running build" : `${label} — simulated`
    );

    if (el.hintTitle) el.hintTitle.textContent = hint[0];
    if (el.hintNote) el.hintNote.textContent = hint[1];

    if (el.buildBar) {
      el.buildBar.classList.toggle("is-running", running);
      el.buildBar.classList.toggle("is-error", build.status === BUILD.ERROR);
    }

    // Configuration is frozen only while a run is in flight.
    [el.provider, el.model, el.apiKey].forEach((control) => {
      if (!control) return;
      control.disabled = running;
    });
    if (el.prompt) {
      if (running) el.prompt.setAttribute("readonly", "");
      else el.prompt.removeAttribute("readonly");
    }
    $$(".chip[data-idea]").forEach((chip) => {
      chip.disabled = running;
    });
    if (el.promptIdea) el.promptIdea.disabled = running;
    if (el.promptClear) el.promptClear.disabled = running && !el.prompt.value;
  }

  /* ------------------------------------------------------------------------
     Connections
     ------------------------------------------------------------------------ */
  function connectionLabel(status) {
    return { disconnected: "Not connected", connecting: "Connecting", connected: "Connected" }[status];
  }

  function connectionTone(status) {
    return { disconnected: "idle", connecting: "active", connected: "ready" }[status];
  }

  function paintConnection(target) {
    const isRoblox = target === "roblox";
    const status = getState().connections[target].status;
    const statusNode = isRoblox ? el.robloxStatus : el.studioStatus;
    const subNode = isRoblox ? el.robloxSub : el.studioSub;
    const button = isRoblox ? el.connectRobloxBtn : el.connectStudioBtn;
    const row = isRoblox ? el.robloxRow : el.studioRow;
    const offSub = isRoblox ? "Account" : "Local bridge";

    setStatus(statusNode, connectionLabel(status), connectionTone(status));

    if (subNode) {
      subNode.textContent = status === "connected" ? "Simulated · this session" : offSub;
    }

    if (row) row.dataset.status = status;

    if (button) {
      const busy = status === "connecting";
      button.textContent =
        status === "connected" ? "Disconnect" : busy ? "Connecting…" : "Connect";
      button.disabled = busy;
      button.setAttribute("aria-busy", String(busy));
      button.setAttribute(
        "aria-label",
        `${status === "connected" ? "Disconnect" : "Connect"} ${
          isRoblox ? "Roblox account" : "Roblox Studio"
        }`
      );
    }
  }

  function paintConnections() {
    paintConnection("roblox");
    paintConnection("studio");
  }

  async function toggleConnection(target) {
    const status = getState().connections[target].status;
    if (status === "connecting") return;

    const result = await BM.connectionController.toggle(target);
    const label = target === "roblox" ? "Roblox connection" : "Studio bridge";

    if (!BM.isOk(result)) {
      toast(result.error.message || "The connection was not available.");
      return;
    }

    toast(status === "connected" ? `${BM.connectionController.label(target)} disconnected` : `${label} simulated`);
  }

  /* ------------------------------------------------------------------------
     Provider / model
     ------------------------------------------------------------------------ */
  function paintProviderOptions() {
    if (!el.provider) return;

    const { settings } = getState();
    const options = providerList()
      .map(
        (provider) =>
          `<option value="${provider.id}"${
            provider.id === settings.provider ? " selected" : ""
          }>${provider.label}</option>`
      )
      .join("");

    // Avoid rebuilding the list on every render; only when it is stale.
    if (el.provider.dataset.built !== options) {
      el.provider.innerHTML = options;
      el.provider.dataset.built = options;
    }
    el.provider.value = settings.provider;
  }

  function paintModelOptions() {
    if (!el.model) return;

    const { settings } = getState();
    const provider = providerFor(settings.provider);
    const options = provider.models
      .map(
        (model) =>
          `<option value="${model.id}"${
            model.id === settings.model ? " selected" : ""
          }>${model.label}</option>`
      )
      .join("");

    if (el.model.dataset.built !== options) {
      el.model.dataset.built = options;
      el.model.innerHTML = options;
    }
    el.model.value = settings.model;

    const hint = $("#model-hint");
    if (hint) hint.textContent = provider.label;
  }

  /* ------------------------------------------------------------------------
     Prompt
     ------------------------------------------------------------------------ */
  function syncPromptChrome() {
    if (!el.prompt) return;
    if (el.promptCount) el.promptCount.textContent = String(el.prompt.value.length);
    if (el.promptClear) el.promptClear.hidden = el.prompt.value.length === 0;
  }

  function setPrompt(text) {
    if (!el.prompt) return;
    el.prompt.value = text;
    el.prompt.focus();
    el.prompt.setSelectionRange(text.length, text.length);
    syncPromptChrome();
    setPromptDraft(text);
    setFieldError("prompt", "");
  }

  /* ------------------------------------------------------------------------
     Build intent
     ------------------------------------------------------------------------ */
  function handleBuildClick() {
    const build = getState().build;

    if (RUNNING_STATUSES.includes(build.status)) {
      BM.buildController.stop().then(() => toast("Build stopped"));
      return;
    }

    if (build.status === BUILD.ERROR) {
      clearErrors();
      BM.buildController.retry().then((result) => {
        if (!BM.isOk(result)) announce("Build not started. Check the highlighted fields.");
      });
      return;
    }

    requestBuild();
  }

  function requestBuild() {
    clearErrors();

    const prompt = el.prompt ? el.prompt.value : "";
    const key = el.apiKey ? el.apiKey.value : "";
    const hasKey = Boolean(key.trim()) || getState().apiKeyPresent;

    BM.buildController.checkConfiguration({ prompt, hasKey }).then((result) => {
      const check = BM.isOk(result) ? result.data : { valid: false, errors: {} };

      if (!check.valid) {
        // Attach each message to the field it belongs to, then move focus.
        Object.keys(check.errors).forEach((field) => setFieldError(field, check.errors[field]));

        if (check.errors.prompt) {
          el.prompt?.focus();
          nudge(el.promptBlock);
        } else if (check.errors.apiKey) {
          el.apiKey?.focus();
          nudge(el.apiKey?.closest(".input-group"));
        }
        announce("Build not started. Check the highlighted fields.");
        return;
      }

      // The key is handed to the controller in memory only — never stored,
      // never logged, never put in a URL. The field is cleared immediately and
      // only a presence flag remains for this session.
      setApiKeyPresent(hasKey);
      if (key.trim()) clearKeyField();
      setFieldError("apiKey", "");
      $("#api-key-hint")?.replaceChildren(
        document.createTextNode("Key entered for this session · not saved")
      );

      BM.buildController.start({ prompt, hasKey }).then((started) => {
        if (BM.isOk(started)) return;
        if (started.error && started.error.type === "validation") {
          Object.keys(started.error.fields || {}).forEach((field) =>
            setFieldError(field, started.error.fields[field])
          );
        }
        announce("Build could not start. Try again.");
      });
    });
  }

  /** Reset the key input and its reveal toggle after a submission. */
  function clearKeyField() {
    if (!el.apiKey) return;
    el.apiKey.value = "";
    el.apiKey.type = "password";
    el.apiKeyToggle?.setAttribute("aria-pressed", "false");
    el.apiKeyToggle?.setAttribute("aria-label", "Show API key");
    el.apiKeyToggle?.querySelectorAll(".icon-eye").forEach((node) => node.removeAttribute("hidden"));
    const eyeOff = el.apiKeyToggle?.querySelector(".icon-eye-off");
    if (eyeOff) eyeOff.classList.add("is-off");
  }

  /** A short shake to point at the field that needs attention. */
  function nudge(node) {
    if (!node || BM.prefersReducedMotion()) return;
    if (typeof node.animate !== "function") return;

    node.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-4px)" },
        { transform: "translateX(4px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 220, easing: "ease-in-out" }
    );
  }

  /* ------------------------------------------------------------------------
     Render — one entry point per state change
     ------------------------------------------------------------------------ */
  function render(view, changed = []) {
    const build = view.build;

    if (changed.includes("build") || changed.length === 0) {
      paintStatusPills(build);
      paintTimeline(build);
      paintStageMarks(build);
      paintProgress(build);
      paintAction(build);

      // The visualizer only moves while a run is in flight.
      updateWorld(el.world, {
        state: RUNNING_STATUSES.includes(build.status)
          ? build.status
          : build.status === BUILD.COMPLETE
          ? "complete"
          : build.status === BUILD.ERROR
          ? "error"
          : "idle",
        progress: build.progress,
      });
    }

    if (changed.includes("settings") || changed.length === 0) {
      paintProviderOptions();
      paintModelOptions();
    }

    if (changed.includes("connections") || changed.length === 0) {
      paintConnections();
    }

    if (changed.includes("build")) {
      if (build.runId !== local.lastRunId) {
        local.lastRunId = build.runId;
        clearErrors();
      }
      announce(
        `Build ${STATUS_LABEL[build.status].toLowerCase()}${
          RUNNING_STATUSES.includes(build.status) && BUILD_STAGES[build.stage]
            ? `: ${BUILD_STAGES[build.stage].label}`
            : ""
        }`
      );
    }
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  function bindEvents() {
    // prompt
    el.prompt?.addEventListener("input", () => {
      syncPromptChrome();
      setPromptDraft(el.prompt.value);
      if (el.prompt.value.trim()) setFieldError("prompt", "");
    });

    el.prompt?.addEventListener("keydown", (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
      event.preventDefault();
      if (BM.isRunning() || el.prompt.readOnly) return;
      requestBuild();
    });

    el.promptClear?.addEventListener("click", () => {
      setPrompt("");
      syncPromptChrome();
    });

    el.promptIdea?.addEventListener("click", () => {
      const text = EXAMPLES[local.exampleIndex % EXAMPLES.length];
      local.exampleIndex += 1;
      setPrompt(text);
    });

    $$(".chip[data-idea]").forEach((chip) => {
      chip.addEventListener("click", () => setPrompt(chip.dataset.idea || ""));
    });

    // configuration
    el.provider?.addEventListener("change", () => {
      BM.settingsController.setProvider(el.provider.value).then((result) => {
        if (!BM.isOk(result)) return toast(result.error.message);
        setFieldError("provider", "");
        toast("Provider updated");
      });
    });

    el.model?.addEventListener("change", () => {
      BM.settingsController.setModel(el.model.value).then((result) => {
        if (!BM.isOk(result)) return toast(result.error.message);
        setFieldError("model", "");
      });
    });

    el.apiKey?.addEventListener("input", () => {
      if (el.apiKey.value.trim()) setFieldError("apiKey", "");
    });

    BM.bindKeyReveal(el.apiKey, el.apiKeyToggle);

    // action
    el.buildButton?.addEventListener("click", handleBuildClick);

    // connections
    el.connectRobloxBtn?.addEventListener("click", () => toggleConnection("roblox"));
    el.connectStudioBtn?.addEventListener("click", () => toggleConnection("studio"));
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    cacheElements();

    mountWorld(el.world);
    renderTimeline();
    renderStageMarks();
    syncPromptChrome();

    // Deep link from the projects page: build.html?prompt=…
    const preset = new URLSearchParams(window.location.search).get("prompt");
    if (preset && el.prompt) {
      el.prompt.value = preset;
      setPromptDraft(preset);
    } else if (el.prompt && getState().build.prompt) {
      el.prompt.value = getState().build.prompt;
    }
    syncPromptChrome();

    bindEvents();
    subscribe(render);
    render(getState(), []);

    // A ticking clock is the only thing that needs its own timer while running.
    window.setInterval(() => {
      const build = getState().build;
      if (RUNNING_STATUSES.includes(build.status)) paintProgress(build);
    }, 200);

    // Intent helper kept for manual testing and later integration.
    Object.assign(BM, { requestBuild, handleBuildClick });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
