/* ==========================================================================
   BuildMind — settings.js
   A renderer over the settings, motion and connection slices of js/state.js.

   Edits go through the store, so the Build workspace sees the same provider,
   model, motion preference and connection status. There is no second copy of
   settings in this file. The API key field is a placeholder: only presence is
   tracked, never the value.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const {
    $,
    toast,
    getState,
    subscribe,
    findProvider,
    setProvider,
    setModel,
    setPreference,
    setMotion,
    resetSettings,
    connectRoblox,
    disconnectRoblox,
    connectStudio,
    disconnectStudio,
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
    el.modelHint = $("#settings-model-hint");
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
     Render helpers
     ------------------------------------------------------------------------ */
  function setStatus(node, text, tone) {
    if (!node) return;
    node.className = `status status--${tone}`;
    const label = $(".status__text", node);
    if (label) label.textContent = text;
  }

  function fillOptions(select, items, selected) {
    if (!select) return;
    const markup = items
      .map(
        (item) =>
          `<option value="${item.id}"${item.id === selected ? " selected" : ""}>${item.label}</option>`
      )
      .join("");

    if (select.dataset.built !== markup) {
      select.dataset.built = markup;
      select.innerHTML = markup;
    }
    select.value = selected;
  }

  function paintAi(view) {
    const { settings } = view;
    const provider = findProvider(settings.provider);

    fillOptions(el.provider, BM.PROVIDERS, settings.provider);
    fillOptions(el.model, provider.models, settings.model);
    if (el.modelHint) el.modelHint.textContent = provider.label;
  }

  function connectionState(status) {
    return {
      label: { disconnected: "Not connected", connecting: "Connecting", connected: "Connected" }[status],
      tone: { disconnected: "idle", connecting: "active", connected: "ready" }[status],
      busy: status === "connecting",
      button: status === "connected" ? "Disconnect" : status === "connecting" ? "Connecting…" : "Connect",
    };
  }

  function paintConnections(view) {
    [
      ["roblox", el.robloxStatus, el.connectRoblox],
      ["studio", el.studioStatus, el.connectStudio],
    ].forEach(([target, statusNode, button]) => {
      const state = connectionState(view.connections[target].status);
      setStatus(statusNode, state.label, state.tone);

      if (!button) return;
      button.textContent = state.button;
      button.disabled = state.busy;
      button.setAttribute("aria-busy", String(state.busy));
      button.setAttribute(
        "aria-label",
        `${view.connections[target].status === "connected" ? "Disconnect" : "Connect"} ${
          target === "roblox" ? "Roblox account" : "Roblox Studio"
        }`
      );
    });
  }

  function paintAppearance(view) {
    document.querySelectorAll("button[data-motion]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.motion === view.motion));
    });
  }

  function paintGeneral(view) {
    el.autoFix?.setAttribute("aria-checked", String(view.settings.autoFix));
    el.hints?.setAttribute("aria-checked", String(view.settings.hints));
  }

  function render(view, changed = []) {
    if (!changed.length || changed.includes("settings")) {
      paintAi(view);
      paintGeneral(view);
    }
    if (!changed.length || changed.includes("connections")) paintConnections(view);
    if (!changed.length || changed.includes("motion")) paintAppearance(view);
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  function bindEvents() {
    el.provider?.addEventListener("change", () => {
      setProvider(el.provider.value);
      toast("Provider updated");
    });

    el.model?.addEventListener("change", () => {
      setModel(el.model.value);
      toast("Model updated");
    });

    BM.bindKeyReveal(el.apiKey, el.apiKeyToggle);
    el.apiKey?.addEventListener("input", () => {
      BM.setApiKeyPresent(Boolean(el.apiKey.value.trim()));
    });

    el.connectRoblox?.addEventListener("click", async () => {
      if (getState().connections.roblox.status === "connected") {
        disconnectRoblox();
        toast("Roblox disconnected");
        return;
      }
      await connectRoblox();
      toast("Roblox connection simulated");
    });

    el.connectStudio?.addEventListener("click", async () => {
      if (getState().connections.studio.status === "connected") {
        disconnectStudio();
        toast("Studio disconnected");
        return;
      }
      await connectStudio();
      toast("Studio bridge simulated");
    });

    document.querySelectorAll("button[data-motion]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.motion;
        if (mode === getState().motion) return;
        setMotion(mode);
        toast(mode === "reduced" ? "Motion reduced" : "Full motion restored");
      });
    });

    el.autoFix?.addEventListener("click", () => {
      const next = el.autoFix.getAttribute("aria-checked") !== "true";
      setPreference("autoFix", next);
      toast(next ? "Auto-fix on" : "Auto-fix off");
    });

    el.hints?.addEventListener("click", () => {
      const next = el.hints.getAttribute("aria-checked") !== "true";
      setPreference("hints", next);
      toast(next ? "Hints on" : "Hints off");
    });

    el.reset?.addEventListener("click", () => {
      resetSettings();
      if (el.apiKey) el.apiKey.value = "";
      BM.setApiKeyPresent(false);
      toast("Settings reset");
    });
  }

  /* ------------------------------------------------------------------------
     Deep links (#ai, #roblox, …) from the header and the home page
     ------------------------------------------------------------------------ */
  function applyHash() {
    if (!window.location.hash) return;

    const target = document.querySelector(window.location.hash);
    if (!target) return;

    window.setTimeout(() => {
      target.scrollIntoView({
        behavior: BM.prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
      const heading = HEADINGS[target.id] ? $(HEADINGS[target.id]) : null;
      heading?.focus({ preventScroll: true });
    }, 220);
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    cache();
    bindEvents();
    subscribe(render);
    render(getState(), []);
    applyHash();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
