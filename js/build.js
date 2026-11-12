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
    lastStatus: "",
    lastMarker: "",
    feedCount: 0,
    feedIds: [],
    stageKey: "",
    contextKey: "",
    deepLinked: "",
    restoring: false,
    clock: 0,
    resultKey: "",
    /** True while a stop request is waiting for the backend to confirm it. */
    stopping: false,
  };

  const LAST_INDEX = BUILD_STAGES.length - 1;
  const MAX_FEED_NODES = 40;

  // Concise prompts that show the range of ideas BuildMind understands.
  // Clicking one only fills the composer; it never starts a build.
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
    el.apiKeyState = $("#api-key-state");
    el.configStatus = $("#build-config-status");
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

    // Phase 5: current stage, activity feed, result summary
    el.stageNow = $("#stage-now");
    el.stageNowLabel = $("#stage-now-label");
    el.stageNowDesc = $("#stage-now-desc");
    el.stageNowIndex = $("#stage-now-index");
    el.feedPanel = $("#activity-feed-panel");
    el.feed = $("#activity-feed");
    el.feedEmpty = $("#activity-empty");
    el.feedCount = $("#activity-count");
    el.result = $("#build-result");
    el.resultName = $("#result-name");
    el.resultBuild = $("#result-build");
    el.resultValidation = $("#result-validation");
    el.resultCreated = $("#result-created");
    el.resultOpen = $("#result-open");
    el.resultAgain = $("#result-again");
    el.context = $("#project-context");
    el.contextTitle = $("#project-context-title");
    el.contextMeta = $("#project-context-meta");
    el.contextClose = $("#project-context-close");
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
        <li class="timeline__step" data-stage="${index}" data-stage-id="${stage.id}">
          <span class="timeline__rail"><span class="timeline__dot"></span></span>
          <span class="timeline__body">
            <span class="timeline__label">${stage.label}</span>
            <span class="timeline__desc">${stage.description}</span>
          </span>
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

    const { status, stage, visits } = build;
    const finished = status === BUILD.COMPLETE;
    const failed = status === BUILD.ERROR;
    const running = RUNNING_STATUSES.includes(status);
    const current = running || failed ? stage : -1;

    el.steps.forEach((step, i) => {
      const stageId = BUILD_STAGES[i] ? BUILD_STAGES[i].id : "";
      const times = (visits && visits[stageId]) || 0;

      // Resolve the step's intended state, then write only what changed.
      let state = "is-pending";
      let meta = "";
      let isCurrent = false;

      if (finished) {
        state = i === LAST_INDEX ? "is-complete" : "is-done";
        meta = i === LAST_INDEX ? "Ready" : "Done";
      } else if (failed) {
        if (i === current) {
          state = "is-failed";
          meta = "Failed";
        } else if (times) {
          state = "is-done";
          meta = "Done";
        }
      } else if (current > -1) {
        if (i === current) {
          state = "is-active";
          meta = "Now";
          isCurrent = true;
        } else if (times) {
          state = "is-done";
          meta = times > 1 ? "×2" : "Done";
        }
      }

      const classes = ["timeline__step", state];
      if (isCurrent && times > 1) classes.push("is-visited");
      if (times > 1 && !isCurrent) classes.push("is-visited");
      const nextClass = classes.join(" ");

      if (step.className !== nextClass) step.className = nextClass;

      if (isCurrent) {
        if (step.getAttribute("aria-current") !== "step") step.setAttribute("aria-current", "step");
      } else if (step.hasAttribute("aria-current")) {
        step.removeAttribute("aria-current");
      }

      const metaNode = $("[data-meta]", step);
      if (metaNode && metaNode.textContent !== meta) metaNode.textContent = meta;
    });
  }

  /** The unmistakable current stage: title, description, index, status. */
  function paintStageNow(build) {
    if (!el.stageNow) return;

    const running = RUNNING_STATUSES.includes(build.status);
    const preparing = build.phase === "preparing";
    const finished = build.status === BUILD.COMPLETE;
    const failed = build.status === BUILD.ERROR;

    let label = "Ready";
    let description = "Describe a game to begin";
    let index = "";

    if (preparing) {
      label = "Preparing build";
      description = "Getting ready to start";
    } else if (running) {
      const stage = BUILD_STAGES[build.stage];
      label = build.stageLabel || (stage ? stage.label : "Building");
      description = build.stageDescription || (stage ? stage.description : "");
      index = `${build.stage + 1} of ${BUILD_STAGES.length}`;
    } else if (finished) {
      label = "Complete";
      description = "Build ready for review";
      index = `${BUILD_STAGES.length} of ${BUILD_STAGES.length}`;
    } else if (failed) {
      label = "Build could not be completed";
      description = "Try again — nothing was published";
    } else if (build.status === BUILD.STOPPED) {
      label = "Build stopped";
      description = "The build was stopped before completion";
    } else if (build.stage >= 0) {
      // A finished-but-reset run keeps its last stage context out of the way.
      label = "Ready";
      description = "Describe a game to begin";
    }

    el.stageNowLabel.textContent = label;
    el.stageNowDesc.textContent = description;
    el.stageNowIndex.textContent = index;
    el.stageNow.dataset.status = preparing ? "preparing" : running ? "running" : build.status;
  }

  /** Agent activity feed: newest first, appended one entry at a time. */
  function paintActivity(build) {
    if (!el.feed) return;

    const activity = build.activity || [];
    const total = activity.length;

    setHidden(el.feedPanel, total === 0);
    setHidden(el.feedEmpty, total > 0);
    setText(el.feedCount, total ? String(total) : "");

    // A new run resets the list rather than diffing it.
    if (total < local.feedCount) {
      el.feed.innerHTML = "";
      local.feedIds = [];
    }
    local.feedCount = total;

    // Only the entries we have not painted yet are inserted (newest on top).
    const painted = new Set(local.feedIds);
    const fresh = activity.filter((entry) => !painted.has(entry.id));
    if (!fresh.length) return;

    fresh
      .slice()
      .reverse()
      .forEach((entry) => {
        const item = document.createElement("li");
        item.className = "log__item";
        item.dataset.stage = entry.stage || "";
        item.dataset.id = entry.id;

        const dot = document.createElement("span");
        dot.className = "log__dot";
        dot.setAttribute("aria-hidden", "true");

        const text = document.createElement("span");
        text.className = "log__text";
        text.textContent = entry.message;

        item.appendChild(dot);
        item.appendChild(text);
        el.feed.prepend(item);
        local.feedIds.push(entry.id);
      });

    // Keep the DOM bounded even if a very long run keeps emitting.
    while (el.feed.children.length > MAX_FEED_NODES) {
      el.feed.removeChild(el.feed.lastElementChild);
    }
  }

  /** Result summary — only after a completed run, never after stop or error. */
  function paintResult(build) {
    if (!el.result) return;

    const result = build.result;
    const show = build.status === BUILD.COMPLETE && Boolean(result);

    setHidden(el.result, !show);
    if (!show) return;

    // The result card is filled once per run, not once per tick: `render` also
    // runs on the elapsed-time clock, and re-writing the same text there is
    // pure layout churn.
    const key = `${build.runId}:${result.projectId || ""}:${result.name || ""}:${result.validation || ""}`;
    if (key === local.resultKey) return;
    local.resultKey = key;

    setText(el.resultName, result.name || "—");
    setText(el.resultBuild, "Complete");
    setText(el.resultValidation, result.validation === "passed" ? "Passed" : "Pending");
    setText(el.resultCreated, "Just now");
    if (el.resultOpen) {
      // "Open project" belongs in Projects, where the record lives.
      const href = result.projectId
        ? `projects.html?project=${encodeURIComponent(result.projectId)}`
        : "projects.html";
      if (el.resultOpen.getAttribute("href") !== href) el.resultOpen.href = href;
    }
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
  /**
   * The elapsed-time readout is the only thing that needs a clock, and only
   * while a run is in flight. Starting is idempotent, and the tick retires
   * itself as soon as the build leaves a running status — so a finished page
   * holds no timer, and a retry cannot stack a second one on top of the first.
   */
  function stopProgressClock() {
    if (local.clock) window.clearInterval(local.clock);
    local.clock = 0;
  }

  function startProgressClock() {
    if (local.clock) return;
    local.clock = window.setInterval(() => {
      const build = getState().build;
      if (!RUNNING_STATUSES.includes(build.status)) {
        stopProgressClock();
        paintProgress(build);
        return;
      }
      paintProgress(build);
    }, 200);
  }

  /**
   * Write text only when it differs. Assigning the same string still queues a
   * mutation record and a text layout, and this panel is repainted on a 200ms
   * clock for the elapsed-time readout. (Measured before this guard: 4 writes
   * per tick, 88 mutations per 3s of a run.)
   */
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  /** Same idea for `hidden`: a redundant write still invalidates style. */
  function setHidden(node, hidden) {
    if (node && node.hidden !== hidden) node.hidden = hidden;
  }

  function paintProgress(build) {
    const pct = Math.max(0, Math.min(100, Math.round(build.progress)));

    if (el.progressFill) {
      const width = `${pct}%`;
      if (el.progressFill.style.width !== width) el.progressFill.style.width = width;
    }
    setText(el.progressValue, `${pct}%`);
    if (el.progressBar && el.progressBar.getAttribute("aria-valuenow") !== String(pct)) {
      el.progressBar.setAttribute("aria-valuenow", String(pct));
    }

    const running = RUNNING_STATUSES.includes(build.status);
    if (el.progress && el.progress.classList.contains("is-running") !== running) {
      el.progress.classList.toggle("is-running", running);
    }

    setText(el.progressState, STATUS_LABEL[build.status]);

    if (el.progressTime) {
      if (build.status === BUILD.READY) setText(el.progressTime, "—");
      else if (build.endedAt && build.startedAt) {
        setText(el.progressTime, `${((build.endedAt - build.startedAt) / 1000).toFixed(1)}s`);
      } else if (build.startedAt) {
        setText(el.progressTime, `${((Date.now() - build.startedAt) / 1000).toFixed(1)}s`);
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
    ready: ["Ready to build", "Runs on the BuildMind server"],
    building: ["Building", "Real run — stop any time"],
    testing: ["Testing", "Real run — stop any time"],
    fixing: ["Fixing", "Resolving detected issues"],
    validating: ["Validating", "Real run — stop any time"],
    complete: ["Build complete", "Added to Projects"],
    stopped: ["Build stopped", "The build was stopped before completion"],
    error: ["Build could not be completed", "Try again"],
  };

  function paintAction(build) {
    if (!el.buildButton) return;

    const preparing = build.phase === "preparing";
    const running = RUNNING_STATUSES.includes(build.status) || preparing;
    const stopping = local.stopping;
    const hint = stopping
      ? ["Stopping", "Waiting for the server to confirm"]
      : preparing
      ? ["Preparing build", "Starting the build on the server"]
      : HINTS[build.status] || HINTS.ready;

    // Primary action label follows the state machine.
    let label = "Build Game";
    let iconName = "";
    if (stopping) {
      label = "Stopping…";
    } else if (running) {
      label = "Stop build";
      iconName = icon("stop");
    } else if (build.status === BUILD.COMPLETE) {
      label = "Build again";
    } else if (build.status === BUILD.STOPPED) {
      label = "Build again";
    } else if (build.status === BUILD.ERROR) {
      label = "Try again";
    }

    el.buildButton.classList.toggle("btn--primary", !running);
    el.buildButton.classList.toggle("btn--ghost", running);
    el.buildButton.innerHTML = `${iconName}<span>${label}</span>`;
    // Never `aria-busy` here: the button stays operable (it is the Stop
    // control while running) and busy would also disable pointer events.
    el.buildButton.removeAttribute("aria-busy");
    el.buildButton.disabled = stopping;
    // The markup ships the button hidden so there is never a dead action
    // before the renderer runs; this is the one place it is revealed.
    el.buildButton.hidden = false;
    el.buildButton.setAttribute(
      "aria-label",
      running ? "Stop the running build" : label
    );

    if (el.hintTitle) el.hintTitle.textContent = hint[0];
    if (el.hintNote) el.hintNote.textContent = hint[1];

    if (el.buildBar) {
      el.buildBar.classList.toggle("is-running", running);
      el.buildBar.classList.toggle("is-error", build.status === BUILD.ERROR);
      el.buildBar.classList.toggle("is-complete", build.status === BUILD.COMPLETE);
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
    return {
      disconnected: "Not connected",
      connecting: "Connecting",
      connected: "Connected",
      unavailable: "External integration required",
    }[status];
  }

  function connectionTone(status) {
    return {
      disconnected: "idle",
      connecting: "active",
      connected: "ready",
      unavailable: "warn",
    }[status];
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
      subNode.textContent =
        status === "connected"
          ? "Connected to the BuildMind server"
          : status === "unavailable"
          ? "Not available on this server"
          : offSub;
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
      toast(result.error.message || "The connection was not available.", "error");
      return;
    }

    // A real OAuth hand-off: the browser leaves for the provider, and the
    // provider sends the user back with a code.
    if (result.data && result.data.authorizeUrl) {
      window.location.assign(result.data.authorizeUrl);
      return;
    }

    const next = result.data && result.data.status;
    if (next === "connected") toast(`${BM.connectionController.label(target)} connected`);
    else if (next === "unavailable") toast(result.error ? result.error.message : `${label} is not available`, "error");
    else toast(`${label} disconnected`);
  }

  /* ------------------------------------------------------------------------
     Provider / model / configuration status
     ------------------------------------------------------------------------ */

  /**
   * The configuration chip on this page and the one in Settings are painted from
   * the same derivation, so the two pages cannot disagree about readiness.
   */
  function setConfigStatus(config) {
    if (!el.configStatus) return;
    const textEl = el.configStatus.querySelector(".status__text");
    if (textEl && textEl.textContent !== config.label) textEl.textContent = config.label;
    const next = `status status--${config.tone}`;
    if (el.configStatus.className !== next) el.configStatus.className = next;
    if (el.configStatus.getAttribute("title") !== config.note) {
      el.configStatus.setAttribute("title", config.note);
    }
  }

  function paintConfigStatus() {
    const config = BM.settingsController.describeConfiguration(getState());
    setConfigStatus(config);

    if (el.apiKeyState) {
      const message = config.keyPresent
        ? "Key held for this session in memory. Not saved."
        : config.needsKey
        ? `${config.provider.label} needs a key before a build can run.`
        : "No key needed for this provider.";
      if (el.apiKeyState.textContent !== message) el.apiKeyState.textContent = message;
    }
  }

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
    const provider = providerFor(settings.provider) || { label: "No provider", models: [] };
    const models = provider.models;
    const options = models
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
    // No provider means no models: say so instead of showing a stale list.
    el.model.disabled = models.length === 0;
    if (models.length === 0) return;
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

    // Covers the `preparing` beat as well as a live run: the second click is
    // always a Stop, never a second build.
    if (RUNNING_STATUSES.includes(build.status) || build.phase === "preparing") {
      if (local.stopping) return;
      local.stopping = true;
      paintAction(build);

      // The stop is a server operation: the UI settles only once the server
      // has confirmed it.
      BM.buildController.stop().then((result) => {
        local.stopping = false;
        paintAction(getState().build);
        if (!BM.isOk(result)) {
          announce(result.error ? result.error.message : "The build could not be stopped.");
          toast(result.error ? result.error.message : "The build could not be stopped.", "error");
          return;
        }
        toast(result.data && result.data.stopped ? "Build stopped" : "The build already finished", "info");
      });
      return;
    }

    const promptNow = el.prompt ? el.prompt.value.trim() : "";
    const samePrompt = promptNow && promptNow === String(build.prompt || "").trim();

    if (build.status === BUILD.ERROR || (build.status === BUILD.STOPPED && samePrompt)) {
      clearErrors();
      const key = el.apiKey ? el.apiKey.value.trim() : "";
      if (key) {
        setApiKeyPresent(true);
        clearKeyField();
      }
      // A retry is a new execution on the server: a new build and a new run.
      BM.buildController.retry(key ? { apiKey: key } : {}).then((result) => {
        if (BM.isOk(result)) return;
        if (result.error && result.error.fields) {
          Object.keys(result.error.fields).forEach((field) =>
            setFieldError(field, result.error.fields[field])
          );
        }
        announce((result.error && result.error.message) || "Build not started. Check the highlighted fields.");
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
      // never logged, never put in a URL. It travels in the request body to
      // the server, which keeps it for the session; the field is cleared
      // immediately and only a presence flag remains here.
      setApiKeyPresent(hasKey);
      if (key.trim()) clearKeyField();
      setFieldError("apiKey", "");
      $("#api-key-hint")?.replaceChildren(
        document.createTextNode("Key sent to the server · never stored in this browser")
      );

      BM.buildController.start({ prompt, hasKey, apiKey: key.trim() }).then((started) => {
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

  /** One announcement per state edge, phrased for a screen reader. */
  function announceActivity(build) {
    if (build.phase === "preparing") {
      announce("Preparing build");
      return;
    }

    if (build.status === BUILD.COMPLETE) {
      const name = build.result && build.result.name ? ` ${build.result.name}` : "";
      announce(`Build complete.${name} Project created.`);
      return;
    }

    if (build.status === BUILD.STOPPED) {
      announce("Build stopped before completion. Nothing was published.");
      return;
    }

    if (build.status === BUILD.ERROR) {
      announce("Build could not be completed. Try again.");
      return;
    }

    if (RUNNING_STATUSES.includes(build.status) && BUILD_STAGES[build.stage]) {
      const stage = BUILD_STAGES[build.stage];
      announce(`${stage.label}. ${build.stageDescription || stage.description}`);
      return;
    }

    announce(`Build ${STATUS_LABEL[build.status].toLowerCase()}`);
  }

  /** Move focus to the result once, without stealing it mid-run. */
  function focusResult() {
    if (!el.result) return;
    el.result.setAttribute("tabindex", "-1");
    el.result.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------------
     Render — one entry point per state change
     ------------------------------------------------------------------------ */
  function render(view, changed = []) {
    const build = view.build;

    if (changed.includes("build") || changed.length === 0) {
      // Progress ticks arrive several times a second; only the pieces that
      // actually depend on the number are repainted for those.
      const stageKey = `${build.runId}:${build.status}:${build.stage}:${build.phase}`;
      const movedStage = stageKey !== local.stageKey;
      local.stageKey = stageKey;

      paintProgress(build);
      if (movedStage) {
        paintStatusPills(build);
        paintStageNow(build);
        paintTimeline(build);
        paintStageMarks(build);
        paintAction(build);
      }
      paintActivity(build);
      paintResult(build);

      // Elapsed-time readout: on only while something is actually running.
      if (RUNNING_STATUSES.includes(build.status)) startProgressClock();
      else stopProgressClock();

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

    if (changed.includes("settings") || changed.includes("apiKeyPresent") || changed.length === 0) {
      paintProviderOptions();
      paintModelOptions();
      paintConfigStatus();
    }

    if (
      changed.includes("projects") ||
      changed.includes("activeProjectId") ||
      changed.length === 0
    ) {
      paintContext(view);
    }

    // Keeping the open project's status in step with the live machine is what
    // stops Projects claiming "Complete" while Build says "Building".
    if (changed.includes("build") || changed.includes("activeProjectId") || changed.length === 0) {
      mirrorProjectStatus(view);
    }

    if (changed.includes("connections") || changed.length === 0) {
      paintConnections();
    }

    if (changed.includes("build")) {
      if (build.runId !== local.lastRunId) {
        local.lastRunId = build.runId;
        clearErrors();
      }

      // Announce the meaningful edges only — not every progress tick.
      const marker = `${build.status}:${build.phase}:${build.stage}`;
      if (marker !== local.lastMarker) {
        local.lastMarker = marker;
        announceActivity(build);
      }

      // Move focus once, when a run settles, so keyboard users are not stranded.
      if (build.status !== local.lastStatus) {
        if (build.status === BUILD.COMPLETE && el.result && !el.result.hidden) {
          focusResult();
        } else if (build.status === BUILD.ERROR || build.status === BUILD.STOPPED) {
          el.buildButton?.focus({ preventScroll: true });
        }
        local.lastStatus = build.status;
      }
    }
  }

  /* ------------------------------------------------------------------------
     Live status mirror — the open project follows the run that is happening
     in front of the user. This renderer never edits project data; it hands
     the new status to the controller, which owns the write.
     ------------------------------------------------------------------------ */
  const MIRRORED = ["building", "testing", "fixing", "validating"];

  function mirrorProjectStatus(view) {
    const id = view.activeProjectId;
    if (!id) return;

    const project = view.projects.find((item) => item.id === id);
    if (!project) return;

    // Only a live run may move a project; terminal states are recorded by the
    // controller when the run actually ends.
    if (!MIRRORED.includes(view.build.status)) return;
    if (project.status === view.build.status) return;

    BM.projectController?.update?.(id, { status: view.build.status });
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
      if (BM.buildController.isBusy() || el.prompt.readOnly) return;
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
      if (el.provider.disabled) return;
      setConfigStatus({ label: "Updating…", tone: "warn", note: "Applying the new provider." });
      BM.settingsController.setProvider(el.provider.value).then((result) => {
        // The model list belongs to the new provider, so repaint both together.
        paintProviderOptions();
        paintModelOptions();
        paintConfigStatus();
        if (!BM.isOk(result)) return toast(result.error.message, "error");
        setFieldError("provider", "");
        toast("Provider updated");
      });
    });

    el.model?.addEventListener("change", () => {
      if (el.model.disabled) return;
      BM.settingsController.setModel(el.model.value).then((result) => {
        paintModelOptions();
        paintConfigStatus();
        if (!BM.isOk(result)) return toast(result.error.message, "error");
        setFieldError("model", "");
      });
    });

    el.apiKey?.addEventListener("input", () => {
      const value = el.apiKey ? el.apiKey.value : "";
      const state = BM.settingsController.describeKeyState(value);
      setFieldError("apiKey", "");
      el.apiKey?.setAttribute("aria-invalid", String(state.invalid));
      if (state.invalid) setFieldError("apiKey", state.message);
      // Presence only: the key itself never enters state. Clearing the field
      // must not claim the session still has a key it was just told about.
      setApiKeyPresent(state.present);
      paintConfigStatus();
    });

    BM.bindKeyReveal(el.apiKey, el.apiKeyToggle);

    // action
    el.buildButton?.addEventListener("click", handleBuildClick);

    // connections
    el.connectRobloxBtn?.addEventListener("click", () => toggleConnection("roblox"));
    el.connectStudioBtn?.addEventListener("click", () => toggleConnection("studio"));

    // result actions: exactly two, both obvious
    el.resultAgain?.addEventListener("click", () => requestBuild());
    el.contextClose?.addEventListener("click", () => {
      BM.projectController.close();
      local.deepLinked = "";
      local.contextKey = "";
      paintContext(getState());
      announce("Project context cleared");
    });

    el.resultOpen?.addEventListener("click", () => {
      // Deep link wins over the stored draft when opening a finished project.
      if (!el.resultOpen.getAttribute("href")) el.resultOpen.href = "projects.html";
    });
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  /**
   * Restore the composer.
   *
   * Order of precedence: a deep link (?project= / ?prompt=) wins, then the
   * draft that comes back through settingsService — this file never reads
   * storage itself. A project deep link goes through the project controller,
   * so the active project, the editable prompt and the Build Again identity
   * all come from one place.
   */
  function restorePrompt() {
    if (!el.prompt) return Promise.resolve();

    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("project");
    const preset = params.get("prompt");

    if (projectId) {
      const openProject = () => {
        if (BM.serviceMode === BM.SERVICE_MODES.REMOTE && !BM.isAuthenticated()) {
          return Promise.resolve();
        }
        local.deepLinked = projectId;
        return BM.projectController.open(projectId).then((result) => {
          if (!BM.isOk(result)) {
            toast("That project could not be opened.", "error");
            return restoreDraft();
          }
          applyProjectContext(result.data.project, true);
          announce("Project loaded. The prompt is editable.");
          return result;
        });
      };

      if (BM.serviceMode === BM.SERVICE_MODES.REMOTE && getState().auth.status === "loading") {
        return new Promise((resolve) => {
          const off = subscribe((view, changed) => {
            if (changed.includes("auth") && view.auth.status !== "loading") {
              off();
              resolve(openProject());
            }
          });
        });
      }

      return openProject();
    }

    if (preset) {
      el.prompt.value = preset;
      setPromptDraft(preset);
      syncPromptChrome();
      return Promise.resolve();
    }

    return restoreDraft();
  }

  function restoreDraft() {
    if (!el.prompt) return Promise.resolve();

    if (getState().build.prompt) {
      el.prompt.value = getState().build.prompt;
      syncPromptChrome();
      return Promise.resolve();
    }

    return BM.settingsService.loadPromptDraft().then((result) => {
      if (!BM.isOk(result) || !result.data.prompt) return;
      if (el.prompt.value) return; // the user already started typing
      el.prompt.value = result.data.prompt;
      setPromptDraft(result.data.prompt);
      syncPromptChrome();
    });
  }

  /**
   * Put an opened project's context in the composer. Only the prompt and the
   * identity are applied: the provider/model stay whatever the user has
   * configured now, and no key is restored — nothing here can.
   */
  function applyProjectContext(project, fillPrompt) {
    if (!project) return;

    // A deep link wins over the stored draft: the project's own prompt is what
    // the user asked to reopen.
    if (fillPrompt && el.prompt) {
      const prompt = project.prompt || "";
      if (prompt) {
        el.prompt.value = prompt;
        setPromptDraft(prompt);
        syncPromptChrome();
      }
    }

    local.deepLinked = project.id;
    local.contextKey = "";
    BM.setActiveProject(project.id);
    paintContext(getState());
  }

  /** The one place the "Building from project" banner is painted. */
  function paintContext(view) {
    if (!el.context) return;

    const project = view.projects.find((item) => item.id === view.activeProjectId) || null;
    const key = project ? `${project.id}:${project.status}:${project.lastBuildAt}:${project.name}` : "";

    el.context.hidden = !project;
    if (!project) {
      local.contextKey = "";
      return;
    }
    if (key === local.contextKey) return;
    local.contextKey = key;

    const meta = BM.projectModel;
    const status = meta.statusMeta(project.status);
    const build = meta.lastBuildLabel(project, Date.now());

    if (el.contextTitle && el.contextTitle.textContent !== project.name) {
      el.contextTitle.textContent = project.name;
    }
    if (el.contextMeta) {
      el.contextMeta.textContent = `${status.label} · ${build}`;
    }
  }

  // Every page module boots once. The DOMContentLoaded guard means a second
  // dispatch (or any future re-entrant call) cannot double-register the
  // listeners and interval below — measured before this guard: a repeated
  // init on build.html took the live listener count from 36 to 69.
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    cacheElements();

    mountWorld(el.world);
    renderTimeline();
    renderStageMarks();
    syncPromptChrome();
    restorePrompt();

    bindEvents();
    subscribe(render);
    render(getState(), []);
    paintContext(getState());
    mirrorProjectStatus(getState());

    // A ticking clock is the only thing that needs its own timer, and only
    // while a run is actually in flight: the tick stops itself the moment the
    // build leaves a running status, so an idle page carries no timer at all.
    startProgressClock();

    // Intent helper kept for manual testing and later integration.
    Object.assign(BM, { requestBuild, handleBuildClick });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
