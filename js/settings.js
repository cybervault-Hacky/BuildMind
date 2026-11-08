/* ==========================================================================
   BuildMind — settings.js
   Provider/model selection, simulated connections, motion preference and
   the two general switches. Everything is stored in this browser only.

   Phase 1 note: connectRoblox() / connectStudio() are simulated. They never
   touch the network, and the API key field is a placeholder that is never
   persisted.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const {
    $,
    $$,
    toast,
    loadSettings,
    saveSettings,
    loadPreferences,
    savePreferences,
    findProvider,
    connectRoblox,
    disconnectRoblox,
    connectStudio,
    disconnectStudio,
    getConnections,
    onStateChange,
  } = BM;

  const el = {};

  const HEADINGS = {
    ai: "#ai-title",
    roblox: "#roblox-title",
    appearance: "#appearance-title",
    general: "#general-title",
  };

  function cache() {
    el.provider = $("#settings-provider");
    el.model = $("#settings-model");
    el.apiKey = $("#settings-api-key");
    el.apiKeyToggle = $("#settings-api-key-toggle");
    el.robloxStatus = $("#settings-roblox-status");
    el.studioStatus = $("#settings-studio-status");
    el.connectRoblox = $("#settings-connect-roblox");
    el.connectStudio = $("#settings-connect-studio");
    el.autoFix = $("#toggle-autofix");
    el.hints = $("#toggle-hints");
    el.reset = $("#reset-settings");
  }

  /* ------------------------------------------------------------------------
     Status helper (mirrors build.js)
     ------------------------------------------------------------------------ */
  function setStatus(node, text, tone) {
    if (!node) return;
    node.className = `status status--${tone}`;
    const label = $(".status__text", node);
    if (label) label.textContent = text;
  }

  /* ------------------------------------------------------------------------
     AI section
     ------------------------------------------------------------------------ */
  function fillModels(providerId, selected) {
    const provider = findProvider(providerId);
    el.model.innerHTML = provider.models
      .map((m) => `<option value="${m.id}">${m.label}</option>`)
      .join("");
    el.model.value = provider.models.some((m) => m.id === selected)
      ? selected
      : provider.models[0].id;
  }

  function initAi() {
    const settings = loadSettings();

    el.provider.value = findProvider(settings.provider).id;
    fillModels(el.provider.value, settings.model);

    el.provider.addEventListener("change", () => {
      fillModels(el.provider.value);
      saveSettings({ provider: el.provider.value, model: el.model.value });
      toast("AI provider saved");
    });

    el.model.addEventListener("change", () => {
      saveSettings({ model: el.model.value });
      toast("Model saved");
    });

    el.apiKeyToggle?.addEventListener("click", () => {
      const showing = el.apiKey.type === "text";
      el.apiKey.type = showing ? "password" : "text";
      el.apiKeyToggle.setAttribute("aria-pressed", String(!showing));
      el.apiKeyToggle.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
    });
  }

  /* ------------------------------------------------------------------------
     Roblox section (simulated)
     ------------------------------------------------------------------------ */
  function paintConnections() {
    const conns = getConnections();

    setStatus(
      el.robloxStatus,
      conns.roblox.connected ? "Connected" : "Not connected",
      conns.roblox.connected ? "ready" : "idle"
    );
    el.connectRoblox.textContent = conns.roblox.connected ? "Disconnect" : "Connect";

    setStatus(
      el.studioStatus,
      conns.studio.connected ? "Connected" : "Not connected",
      conns.studio.connected ? "ready" : "idle"
    );
    el.connectStudio.textContent = conns.studio.connected
      ? "Disconnect"
      : "Connect Studio";
  }

  async function toggleRoblox() {
    const button = el.connectRoblox;
    if (getConnections().roblox.connected) {
      disconnectRoblox();
      toast("Roblox disconnected");
      return;
    }
    button.classList.add("is-loading");
    await connectRoblox();
    button.classList.remove("is-loading");
    toast("Roblox connection simulated");
  }

  async function toggleStudio() {
    const button = el.connectStudio;
    if (getConnections().studio.connected) {
      disconnectStudio();
      toast("Studio disconnected");
      return;
    }
    button.classList.add("is-loading");
    await connectStudio();
    button.classList.remove("is-loading");
    toast("Studio bridge simulated");
  }

  /* ------------------------------------------------------------------------
     Appearance
     ------------------------------------------------------------------------ */
  function paintMotion(mode) {
    $$("[data-motion]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.motion === mode));
    });
  }

  function initAppearance() {
    const prefs = loadPreferences();
    paintMotion(prefs.motion || "full");

    $$("[data-motion]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.motion;
        savePreferences({ motion: mode });
        paintMotion(mode);
        toast(mode === "reduced" ? "Motion reduced" : "Full motion restored");
      });
    });
  }

  /* ------------------------------------------------------------------------
     General switches
     ------------------------------------------------------------------------ */
  function initSwitches() {
    const settings = loadSettings();

    el.autoFix.setAttribute("aria-checked", String(settings.autoFix !== false));
    el.hints.setAttribute("aria-checked", String(settings.robuxHints !== false));

    el.autoFix.addEventListener("click", () => {
      const next = el.autoFix.getAttribute("aria-checked") !== "true";
      el.autoFix.setAttribute("aria-checked", String(next));
      saveSettings({ autoFix: next });
      toast(next ? "Auto-fix on" : "Auto-fix off");
    });

    el.hints.addEventListener("click", () => {
      const next = el.hints.getAttribute("aria-checked") !== "true";
      el.hints.setAttribute("aria-checked", String(next));
      saveSettings({ robuxHints: next });
      toast(next ? "Hints on" : "Hints off");
    });
  }

  /* ------------------------------------------------------------------------
     Reset
     ------------------------------------------------------------------------ */
  function initReset() {
    el.reset.addEventListener("click", () => {
      saveSettings({ ...BM.defaults });
      savePreferences({ motion: "full" });

      const settings = loadSettings();
      el.provider.value = findProvider(settings.provider).id;
      fillModels(el.provider.value, settings.model);
      el.autoFix.setAttribute("aria-checked", String(settings.autoFix !== false));
      el.hints.setAttribute("aria-checked", String(settings.robuxHints !== false));
      paintMotion("full");
      el.apiKey.value = "";

      toast("Settings reset");
    });
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    cache();
    initAi();
    paintConnections();
    initAppearance();
    initSwitches();
    initReset();

    el.connectRoblox.addEventListener("click", toggleRoblox);
    el.connectStudio.addEventListener("click", toggleStudio);

    onStateChange((type) => {
      if (type === "connection") paintConnections();
    });

    // Deep links from the header / home page (#ai, #roblox)
    if (window.location.hash) {
      const target = document.querySelector(window.location.hash);
      if (target) {
        window.setTimeout(() => {
          target.scrollIntoView({ behavior: BM.prefersReducedMotion() ? "auto" : "smooth", block: "start" });
          const heading = HEADINGS[target.id] ? $(HEADINGS[target.id]) : null;
          heading?.focus({ preventScroll: true });
        }, 220);
      }
    }

    Object.assign(BM, {
      connectRoblox: toggleRoblox,
      connectStudio: toggleStudio,
      saveSettings,
      savePreferences,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
