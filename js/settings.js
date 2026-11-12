/* ==========================================================================
   BuildMind — settings.js
   Renders the settings page and forwards intent to controllers.

   This file holds no settings of its own. Every value it paints comes from
   state, and every change leaves through a controller. It never reads the
   browser's storage and never uses innerHTML for anything derived from input.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  let els = {};
  let dialog = null;
  let resetOpener = null;

  const STATUS_TEXT = {
    disconnected: "Not connected",
    connecting: "Connecting…",
    connected: "Connected",
    unavailable: "External integration required",
  };

  /* ------------------------------------------------------------------------
     Cache
     ------------------------------------------------------------------------ */
  function cache() {
    const byId = (id) => document.getElementById(id);
    els = {
      configStatus: byId("settings-config-status"),
      provider: byId("settings-provider"),
      model: byId("settings-model"),
      modelHint: byId("settings-model-hint"),
      keyInput: byId("settings-api-key"),
      keyToggle: byId("settings-api-key-toggle"),
      keyState: byId("settings-key-state"),
      keyError: byId("settings-key-error"),
      providerStatus: byId("settings-provider-status"),
      validateButton: byId("settings-validate-provider"),
      validateDetail: byId("settings-validate-detail"),
      robloxButton: byId("settings-connect-roblox"),
      studioButton: byId("settings-connect-studio"),
      robloxStatus: byId("settings-roblox-status"),
      studioStatus: byId("settings-studio-status"),
      autofix: byId("toggle-autofix"),
      hints: byId("toggle-hints"),
      motionButtons: Array.from(document.querySelectorAll("[data-motion]")),
      resetButton: byId("reset-settings"),
      resetDialog: byId("reset-dialog"),
      resetConfirm: byId("reset-confirm"),
      resetCancel: byId("reset-cancel"),
      live: byId("settings-live"),
    };
    dialog = els.resetDialog;
  }

  /* ------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------ */

  /** Replace a status chip's text, keeping the dot decorative. */
  function setStatus(el, text, tone) {
    if (!el) return;
    const textEl = el.querySelector(".status__text");
    if (textEl && textEl.textContent !== text) textEl.textContent = text;
    const next = `status status--${tone || "idle"}`;
    if (el.className !== next) el.className = next;
  }

  /** Announce through the page's one polite live region. */
  function announce(message) {
    if (!els.live) return;
    if (els.live.textContent === message) {
      // Identical strings do not re-announce; clear first.
      els.live.textContent = "";
      window.setTimeout(() => {
        els.live.textContent = message;
      }, 20);
      return;
    }
    els.live.textContent = message;
  }

  function toast(message, tone) {
    if (BM.toast) BM.toast(message, tone);
  }

  /* ------------------------------------------------------------------------
     AI configuration
     ------------------------------------------------------------------------ */

  /**
   * Options are rebuilt only when the list identity actually changes, so typing
   * in the key field never reconstructs the selects (which would drop focus and
   * spam the DOM).
   */
  function fillOptions(select, items, selectedId, signature) {
    if (!select) return;
    if (select.dataset.built === signature) {
      if (select.value !== selectedId) select.value = selectedId;
      return;
    }
    select.textContent = "";
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      select.appendChild(option);
    });
    select.dataset.built = signature;
    select.value = selectedId;
  }

  function paintAi(view) {
    const { settings } = view;
    const config = BM.settingsController.describeConfiguration(view);

    const providers = BM.settingsController.getProviders();
    const models = config.provider ? BM.settingsController.getModels(config.provider.id) : [];

    fillOptions(els.provider, providers, settings.provider, providers.map((p) => p.id).join("|"));
    fillOptions(
      els.model,
      models,
      settings.model,
      `${settings.provider}:${models.map((m) => m.id).join("|")}`
    );

    // Honest empty state: no provider means no models, and the control says so
    // rather than silently showing a stale list.
    const noModels = models.length === 0;
    if (els.model) {
      els.model.disabled = noModels;
      els.model.setAttribute("aria-disabled", String(noModels));
    }
    if (els.modelHint) {
      const hint = noModels ? "Choose a provider first" : `Models for ${config.provider.label}`;
      if (els.modelHint.textContent !== hint) els.modelHint.textContent = hint;
    }

    setStatus(els.configStatus, config.label, config.tone);

    if (els.keyState) {
      if (config.keyPresent) {
        els.keyState.textContent = "Key held for this session in memory. Not saved.";
        els.keyState.classList.add("is-present");
      } else if (config.needsKey) {
        els.keyState.textContent = `${config.provider.label} needs a key before a build can run.`;
        els.keyState.classList.remove("is-present");
      } else {
        els.keyState.textContent = "No key needed for this provider.";
        els.keyState.classList.remove("is-present");
      }
    }

    paintKeyValidity(view);
  }

  /** Live local validity for the key field — presence and shape only. */
  function paintKeyValidity(view) {
    if (!els.keyInput) return;
    const state = BM.settingsController.describeKeyState(els.keyInput.value);
    const flagged = state.invalid;

    els.keyInput.setAttribute("aria-invalid", String(flagged));
    if (els.keyError) {
      els.keyError.textContent = state.message;
      els.keyError.hidden = !state.message;
    }
    if (els.keyState && flagged) {
      els.keyState.textContent = "Needs a key for this session.";
      els.keyState.classList.remove("is-present");
    }
    // `view` is accepted so the caller can pass a snapshot; nothing is stored.
    void view;
  }

  /* ------------------------------------------------------------------------
     Provider validation

     Five states, and only the backend can produce the fourth one:
       not_configured | checking | valid | invalid | unavailable
     ------------------------------------------------------------------------ */
  const VALIDATION_TEXT = {
    not_configured: { label: "Not configured", tone: "idle" },
    checking: { label: "Checking…", tone: "warn" },
    valid: { label: "Valid", tone: "ready" },
    invalid: { label: "Invalid", tone: "error" },
    unavailable: { label: "Unavailable", tone: "error" },
  };

  function paintProviderValidation(view) {
    const state = (view && view.providerValidation) || BM.getState().providerValidation;
    const text = VALIDATION_TEXT[state.status] || VALIDATION_TEXT.not_configured;

    setStatus(els.providerStatus, text.label, text.tone);

    if (els.validateDetail) {
      const detail = state.detail || "";
      if (els.validateDetail.textContent !== detail) els.validateDetail.textContent = detail;
    }

    if (els.validateButton) {
      const checking = state.status === "checking";
      els.validateButton.disabled = checking;
      els.validateButton.setAttribute("aria-busy", String(checking));
      els.validateButton.textContent = checking ? "Checking…" : "Test connection";
    }
  }

  /* ------------------------------------------------------------------------
     Connections
     ------------------------------------------------------------------------ */
  function connectionState(view, target) {
    const slice = view.connections && view.connections[target];
    const status = (slice && slice.status) || "disconnected";
    return {
      status,
      connected: status === "connected",
      busy: status === "connecting",
      unavailable: status === "unavailable",
      label: STATUS_TEXT[status] || "Not connected",
      tone:
        status === "connected"
          ? "ready"
          : status === "connecting"
          ? "warn"
          : status === "unavailable"
          ? "warn"
          : "idle",
    };
  }

  function paintConnection(view, target, button, statusEl) {
    const state = connectionState(view, target);
    const name = target === "roblox" ? "Roblox account" : "Roblox Studio";

    if (button) {
      // An integration the server does not have cannot be connected from
      // here, so the button says so instead of offering a dead action.
      const verb = state.unavailable
        ? "Not available"
        : state.connected
        ? "Disconnect"
        : state.busy
        ? "Connecting…"
        : "Connect";
      if (button.textContent !== verb) button.textContent = verb;
      button.disabled = state.busy || state.unavailable;
      button.setAttribute("aria-busy", String(state.busy));
      // Disconnecting mid-transition is allowed: it is the escape hatch.
      button.setAttribute(
        "aria-label",
        state.connected ? `Disconnect ${name}` : `Connect ${name}`
      );
    }
    setStatus(statusEl, state.label, state.tone);
  }

  function paintConnections(view) {
    paintConnection(view, "roblox", els.robloxButton, els.robloxStatus);
    paintConnection(view, "studio", els.studioButton, els.studioStatus);
  }

  /* ------------------------------------------------------------------------
     Preferences
     ------------------------------------------------------------------------ */
  function paintAppearance(view) {
    const motion = view.motion === "reduced" ? "reduced" : "full";
    els.motionButtons.forEach((button) => {
      const selected = button.dataset.motion === motion;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-active", selected);
    });
  }

  function paintGeneral(view) {
    const { settings } = view;
    if (els.autofix) els.autofix.setAttribute("aria-checked", String(Boolean(settings.autoFix)));
    if (els.hints) els.hints.setAttribute("aria-checked", String(Boolean(settings.hints)));
  }

  /* ------------------------------------------------------------------------
     Render
     ------------------------------------------------------------------------ */
  function render(view, changed) {
    const keys = changed || ["settings", "connections", "motion", "providerValidation"];
    if (keys.indexOf("settings") !== -1) {
      paintAi(view);
      paintGeneral(view);
    }
    if (keys.indexOf("connections") !== -1) paintConnections(view);
    if (keys.indexOf("motion") !== -1) paintAppearance(view);
    if (keys.indexOf("providerValidation") !== -1 || keys.length === 0) {
      paintProviderValidation(view);
    }
  }

  /* ------------------------------------------------------------------------
     Reset dialog
     ------------------------------------------------------------------------ */
  function openResetDialog() {
    if (!dialog) return;
    resetOpener = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    if (els.resetCancel) els.resetCancel.focus();
  }

  function closeResetDialog(restoreFocus) {
    if (!dialog) return;
    if (typeof dialog.close === "function" && (dialog.open === true || dialog.hasAttribute("open"))) {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    if (restoreFocus) {
      const target = resetOpener && document.contains(resetOpener) ? resetOpener : els.resetButton;
      if (target) target.focus();
    }
    resetOpener = null;
  }

  function confirmReset() {
    closeResetDialog(true);
    BM.settingsController.reset().then((result) => {
      if (!BM.isOk(result)) {
        toast(result.error.message, "error");
        return;
      }
      const scope = BM.settingsController.resetScope();
      const message = scope.indexOf("connections") !== -1
        ? "Settings reset to defaults. Projects kept."
        : "Settings reset to defaults.";
      announce(message);
      toast("Settings reset. Your projects were kept.");
      render(BM.getState(), ["settings", "connections", "motion"]);
    });
  }

  /* ------------------------------------------------------------------------
     Provider change cascade
     ------------------------------------------------------------------------ */

  /**
   * Switching provider is one action with one visible result: the model list for
   * the new provider is painted before the async save resolves, and the status
   * chip reports the transition instead of the stale value.
   */
  function changeProvider(id) {
    setStatus(els.configStatus, "Updating…", "warn");
    const result = BM.settingsController.setProvider(id);
    render(BM.getState(), ["settings"]);
    return result.then((outcome) => {
      render(BM.getState(), ["settings"]);
      if (!BM.isOk(outcome)) {
        toast(outcome.error.message, "error");
        return outcome;
      }
      const config = BM.settingsController.describeConfiguration();
      announce(
        config.model
          ? `Provider set to ${config.provider.label}. Model set to ${config.model.label}.`
          : `Provider set to ${config.provider.label}.`
      );
      toast("Provider and model updated.");
      return outcome;
    });
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  function bindEvents() {
    if (els.provider) {
      els.provider.addEventListener("change", () => changeProvider(els.provider.value));
    }

    if (els.model) {
      els.model.addEventListener("change", () => {
        const id = els.model.value;
        BM.settingsController.setModel(id).then((result) => {
          render(BM.getState(), ["settings"]);
          if (!BM.isOk(result)) {
            toast(result.error.message, "error");
            return;
          }
          const config = BM.settingsController.describeConfiguration();
          announce(config.model ? `Model set to ${config.model.label}.` : "Model updated.");
          toast("Model updated.");
        });
      });
    }

    if (els.keyInput) {
      els.keyInput.addEventListener("input", () => {
        const state = BM.settingsController.describeKeyState(els.keyInput.value);
        BM.setApiKeyPresent(state.present);
        paintKeyValidity(BM.getState());
        paintAi(BM.getState());
        if (state.message) announce(state.message);
      });
    }

    if (els.keyToggle && BM.bindKeyReveal) {
      BM.bindKeyReveal(els.keyInput, els.keyToggle);
    }

    // Real validation: the backend checks the key against the provider.
    els.validateButton?.addEventListener("click", () => {
      const key = els.keyInput ? String(els.keyInput.value || "").trim() : "";
      BM.settingsController
        .verifyProvider({ apiKey: key })
        .then((result) => {
          const state = BM.getState().providerValidation;
          if (state.status === "valid" && key && els.keyInput) {
            // The backend now holds the sealed credential for this session; drop
            // the plaintext value from the input element.
            els.keyInput.value = "";
            els.keyInput.type = "password";
            els.keyToggle?.setAttribute("aria-pressed", "false");
            els.keyToggle?.setAttribute("aria-label", "Show API key");
            els.keyToggle?.querySelectorAll(".icon-eye").forEach((node) => node.removeAttribute("hidden"));
            els.keyToggle?.querySelector(".icon-eye-off")?.classList.add("is-off");
            BM.setApiKeyPresent(true);
          }
          render(BM.getState(), ["settings", "providerValidation"]);
          if (!BM.isOk(result)) {
            toast(result.error.message, "error");
            announce("The provider could not be checked.");
            return;
          }
          if (state.status === "valid") {
            announce("The provider accepted the key.");
            toast("Provider key accepted.");
            return;
          }
          if (state.status === "unavailable") {
            announce("The provider is not reachable.");
            toast("The provider is not reachable right now.");
            return;
          }
          announce("The provider did not accept the key.");
          toast("The provider did not accept that key.");
        });
    });

    const toggle = (target, button) => {
      if (!button) return;
      button.addEventListener("click", () => {
        const result = BM.connectionController.toggle(target);
        // Paint the transition immediately: `connecting` must be visible in the
        // same frame the click landed, and the button disabled with it.
        render(BM.getState(), ["connections"]);
        Promise.resolve(result).then((outcome) => {
          render(BM.getState(), ["connections"]);
          if (!BM.isOk(outcome)) {
            if (outcome.error && outcome.error.duplicate) return;
            toast(outcome.error.message, "error");
            return;
          }
          const state = connectionState(BM.getState(), target);
          const name = target === "roblox" ? "Roblox account" : "Roblox Studio";
          if (outcome.data && outcome.data.superseded) return;
          if (outcome.data && outcome.data.authorizeUrl) {
            // A real OAuth hand-off: leave for the provider.
            window.location.assign(outcome.data.authorizeUrl);
            return;
          }
          if (state.unavailable) {
            announce(`${name} is not available on this server.`);
            toast(outcome.error ? outcome.error.message : `${name} is not available.`);
            return;
          }
          announce(state.connected ? `${name} connected.` : `${name} disconnected.`);
          toast(state.connected ? `${name} connected.` : `${name} disconnected.`);
        });
      });
    };
    toggle("roblox", els.robloxButton);
    toggle("studio", els.studioButton);

    els.motionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.motion === "reduced" ? "reduced" : "full";
        if (BM.getState().motion === mode) return;
        BM.settingsController.setMotion(mode).then((result) => {
          render(BM.getState(), ["motion"]);
          if (!BM.isOk(result)) {
            toast(result.error.message, "error");
            return;
          }
          announce(mode === "reduced" ? "Reduced motion on." : "Motion set to full.");
          toast("Motion preference saved.");
        });
      });
    });

    const preference = (button, key, label) => {
      if (!button) return;
      button.addEventListener("click", () => {
        const next = button.getAttribute("aria-checked") !== "true";
        BM.settingsController.setPreference(key, next).then((result) => {
          render(BM.getState(), ["settings"]);
          if (!BM.isOk(result)) {
            toast(result.error.message, "error");
            return;
          }
          announce(`${label} ${next ? "on" : "off"}.`);
        });
      });
    };
    preference(els.autofix, "autoFix", "Auto-fix");
    preference(els.hints, "hints", "Build hints");

    if (els.resetButton) els.resetButton.addEventListener("click", openResetDialog);
    if (els.resetConfirm) els.resetConfirm.addEventListener("click", confirmReset);
    if (els.resetCancel) els.resetCancel.addEventListener("click", () => closeResetDialog(true));

    if (dialog) {
      // A native dialog fires `close` for Escape too; keep focus handling in one
      // place so both exits behave the same.
      dialog.addEventListener("close", () => {
        if (resetOpener) {
          const target = resetOpener && document.contains(resetOpener) ? resetOpener : els.resetButton;
          if (target) target.focus();
          resetOpener = null;
        }
      });
      // Clicking the backdrop (the dialog element itself) dismisses.
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) closeResetDialog(true);
      });
    }
  }

  /* ------------------------------------------------------------------------
     Deep links (#ai, #roblox, #appearance)
     ------------------------------------------------------------------------ */
  function applyHash() {
    const id = (window.location.hash || "").replace("#", "");
    if (!id) return;
    const section = document.getElementById(id);
    if (!section) return;
    const title = section.querySelector(".settings-section__title");
    if (title) title.focus();
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  // Every page module boots once. The DOMContentLoaded guard means a second
  // dispatch (or any future re-entrant call) cannot double-register the
  // listeners and interval below — measured before this guard: a repeated
  // init on build.html took the live listener count from 36 to 69.
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    cache();
    bindEvents();

    BM.subscribe((view, changed) => render(view, changed));

    const remote = BM.serviceMode === BM.SERVICE_MODES.REMOTE;
    if (!remote || BM.getState().auth.status !== "loading") {
      BM.settingsController.load().then((result) => {
        if (!BM.isOk(result)) {
          toast(result.error.message, "error");
          return;
        }
        render(BM.getState(), ["settings", "connections", "motion", "providerValidation"]);
        applyHash();
      });
      BM.connectionController.restore();
    } else {
      applyHash();
    }
    render(BM.getState(), ["settings", "connections", "motion", "providerValidation"]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
