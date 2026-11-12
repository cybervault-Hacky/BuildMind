/* ==========================================================================
   BuildMind — account.js
   The Account section of the Settings page.

   Scope, deliberately small: sign in, create an account, sign out, and offer
   to move projects that already exist in this browser onto the account. It is
   not a dashboard, and it does not introduce a new visual language — every
   element used here already exists in css/main.css (`.setting-row`, `.field`,
   `.input`, `.btn`, `.status-pill`).

   The session itself belongs to the auth controller: this file renders the
   state the controller publishes and forwards intent to it. There is no
   second copy of "who is signed in" here.

   Three states are rendered, never two: while the session is being checked
   the section says so, so the page never flashes a signed-in layout that it
   then has to hide — or a signed-out one that it has to replace.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const $ = BM.$;
  const $$ = BM.$$;

  const el = {
    mode: $("#account-mode"),
    signedOut: $("#account-signed-out"),
    signedIn: $("#account-signed-in"),
    pending: $("#account-pending"),
    identity: $("#account-identity"),
    storageNote: $("#account-storage-note"),
    openAuth: $("#account-open-auth"),
    form: $("#account-form"),
    email: $("#account-email"),
    password: $("#account-password"),
    emailError: $("#email-error"),
    passwordError: $("#password-error"),
    formError: $("#account-error"),
    submit: $("#account-submit"),
    toggleMode: $("#account-toggle-mode"),
    signOut: $("#account-sign-out"),
    migration: $("#account-migration"),
    migrate: $("#account-migrate"),
    note: $("#account-note"),
    live: $("#settings-live"),
  };

  if (!el.form) return; // not the settings page

  /** "signin" | "register" */
  let formMode = "signin";
  let busy = false;

  function announce(message) {
    if (el.live) el.live.textContent = message;
  }

  function setError(node, message) {
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  }

  function clearErrors() {
    setError(el.emailError, "");
    setError(el.passwordError, "");
    setError(el.formError, "");
  }

  /** Paint the whole section from the authoritative auth state. */
  function render(authState) {
    const state = authState || BM.getState().auth;
    const status = state.status || "loading";
    const authenticated = status === "authenticated";
    const user = authenticated ? state.user : null;
    const remote = BM.serviceMode === BM.SERVICE_MODES.REMOTE;

    if (el.mode) {
      el.mode.textContent = remote ? "Server storage" : "Local only";
      el.mode.dataset.mode = remote ? "remote" : "local";
    }
    if (el.note) {
      el.note.textContent = remote
        ? "Sign in to access and store your projects on the BuildMind server."
        : "Projects stay in this browser while simulated mode is active.";
    }

    // The three states are exclusive: pending, signed out, signed in.
    if (el.pending) el.pending.hidden = status !== "loading";
    if (el.signedOut) el.signedOut.hidden = status !== "unauthenticated" && status !== "error";
    if (el.signedIn) el.signedIn.hidden = !authenticated;

    if (authenticated && user) {
      if (el.identity) el.identity.textContent = `${user.displayName || "Signed in"} · ${user.email}`;
      if (el.storageNote) {
        el.storageNote.textContent = remote
          ? "Projects are stored on the BuildMind server."
          : "Projects stay in this browser.";
      }
    }

    // The sign-in form only exists in the signed-out state.
    if (el.form) el.form.hidden = status !== "unauthenticated" && status !== "error";
    if (el.openAuth) el.openAuth.hidden = status !== "unauthenticated" && status !== "error";

    // Migration is only offered when there is something local to move AND the
    // account is live. Offering it otherwise would be a dead button.
    const localCount = localProjectCount();
    if (el.migration) el.migration.hidden = !(authenticated && localCount > 0);
    if (el.migrate && localCount > 0) {
      el.migrate.textContent = `Move ${localCount} project${localCount === 1 ? "" : "s"}…`;
    }
  }

  /** How many projects exist in localStorage right now. */
  function localProjectCount() {
    try {
      const storage = BM.storage;
      const raw = storage ? storage.readJSON(BM.STORAGE_KEYS.projects) : null;
      const list = raw && Array.isArray(raw.projects) ? raw.projects : Array.isArray(raw) ? raw : [];
      return list.length;
    } catch {
      return 0;
    }
  }

  /* ------------------------------------------------------------------------
     Session
     ------------------------------------------------------------------------ */
  function refresh() {
    // The controller owns the session; this file only asks for the state.
    if (BM.authController && typeof BM.authController.bootstrap === "function") {
      return BM.authController.bootstrap().then((result) => {
        render(BM.getState().auth);
        if (BM.isOk(result) && BM.isAuthenticated()) BM.projectController?.load();
        return result;
      });
    }
    render(BM.getState().auth);
    return Promise.resolve(BM.serviceOk(null));
  }

  function submitAuth(event) {
    event.preventDefault();
    if (busy) return;

    clearErrors();
    const email = String(el.email?.value || "").trim();
    const password = String(el.password?.value || "");

    // Client-side shape checks exist to save a round trip, not to be the
    // authority: the server validates everything again.
    let invalid = false;
    if (!email || email.indexOf("@") === -1) {
      setError(el.emailError, "Enter your email address.");
      invalid = true;
    }
    if (!password || (formMode === "register" && password.length < 12)) {
      setError(
        el.passwordError,
        formMode === "register" ? "Use at least 12 characters." : "Enter your password."
      );
      invalid = true;
    }
    if (invalid) return;

    busy = true;
    if (el.submit) {
      el.submit.disabled = true;
      el.submit.textContent = formMode === "register" ? "Creating…" : "Signing in…";
    }

    const controller = BM.authController;
    const call =
      formMode === "register"
        ? controller.register({ email, password })
        : controller.login({ email, password });

    call.then((result) => {
      busy = false;
      if (el.submit) {
        el.submit.disabled = false;
        el.submit.textContent = formMode === "register" ? "Create account" : "Sign in";
      }

      if (!BM.isOk(result)) {
        const fields = (result.error && result.error.fields) || {};
        setError(el.emailError, fields.email || "");
        setError(el.passwordError, fields.password || "");
        setError(el.formError, fields.form || (result.error && result.error.message) || "");
        announce("Sign-in did not complete.");
        render(BM.getState().auth);
        return;
      }

      // The password has done its job: drop it from the DOM immediately.
      if (el.password) el.password.value = "";
      if (el.form) el.form.hidden = true;
      if (el.openAuth) el.openAuth.hidden = false;

      // The session token never reached script (HttpOnly cookie); only the
      // CSRF token and the public user came back.
      render(BM.getState().auth);
      announce(formMode === "register" ? "Account created." : "Signed in.");
      BM.toast?.(formMode === "register" ? "Account created" : "Signed in");

      // The projects, provider catalogue and connection state that required a
      // session can now be loaded.
      BM.settingsController?.load?.();
      BM.connectionController?.restore?.();
      BM.projectController?.load();
    });
  }

  function signOut() {
    return BM.authController.logout().then(() => {
      // The mode is unchanged: signing out ends the session, it does not
      // change which backend the deployment talks to.
      render(BM.getState().auth);
      announce("Signed out.");
      BM.toast?.("Signed out");
    });
  }

  /* ------------------------------------------------------------------------
     Migration
     ------------------------------------------------------------------------ */
  /**
   * Copy local projects into the account.
   *
   * Rules this follows:
   *   * it only runs on an explicit click
   *   * it never uploads a provider key — only name, description and prompt
   *   * it does not delete the local copies, so a failure loses nothing
   *   * it skips a project whose name already exists on the account, so
   *     running it twice does not duplicate anything
   */
  function migrate() {
    if (busy) return;
    busy = true;
    if (el.migrate) {
      el.migrate.disabled = true;
      el.migrate.textContent = "Moving…";
    }

    const storage = BM.storage;
    const raw = storage ? storage.readJSON(BM.STORAGE_KEYS.projects) : null;
    const local = raw && Array.isArray(raw.projects) ? raw.projects : Array.isArray(raw) ? raw : [];

    return BM.api.listProjects({ limit: 100 }).then((existing) => {
      const names = new Set(
        (BM.isOk(existing) ? existing.data.projects : []).map((p) => String(p.name).toLowerCase())
      );

      const pending = local.filter((project) => {
        const name = String(project && project.name ? project.name : "").trim();
        return name && !names.has(name.toLowerCase());
      });

      const skipped = local.length - pending.length;

      return pending
        .reduce(
          (chain, project) =>
            chain.then(() =>
              BM.api.createProject({
                name: String(project.name).slice(0, 60),
                description: String(project.description || "").slice(0, 280),
                ...(project.prompt ? { prompt: String(project.prompt) } : {}),
              })
            ),
          Promise.resolve()
        )
        .then(() => {
          busy = false;
          if (el.migrate) {
            el.migrate.disabled = false;
            el.migrate.textContent = "Move projects…";
          }

          const moved = pending.length;
          if (el.migration) el.migration.hidden = true;
          announce(
            `${moved} project${moved === 1 ? "" : "s"} moved to your account` +
              (skipped ? `; ${skipped} already existed.` : ".")
          );
          BM.toast?.(moved ? `Moved ${moved} project${moved === 1 ? "" : "s"}` : "Nothing to move");
          return BM.projectController?.load();
        });
    });
  }

  /* ------------------------------------------------------------------------
     Roblox OAuth callback

     The provider sends the user back with a code and the state it was given.
     Both are read from the URL and posted straight back to the backend: the
     state is never stored in the browser.
     ------------------------------------------------------------------------ */
  function completeRobloxCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return Promise.resolve(null);

    const service = BM.robloxService;
    if (!service || typeof service.complete !== "function") return Promise.resolve(null);

    return service.complete(code, state).then((result) => {
      if (!BM.isOk(result)) {
        announce("Roblox could not be connected.");
        BM.toast?.("Roblox could not be connected.");
        return result;
      }
      BM.setConnectionStatus("roblox", result.data.status || "disconnected");
      announce("Roblox account connected.");
      BM.toast?.("Roblox account connected");
      return result;
    });
  }

  /* ------------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------------ */
  function setFormMode(next) {
    formMode = next;
    clearErrors();
    if (el.submit) el.submit.textContent = next === "register" ? "Create account" : "Sign in";
    if (el.toggleMode) {
      el.toggleMode.textContent = next === "register" ? "Sign in instead" : "Create an account instead";
    }
    if (el.password) {
      el.password.setAttribute("autocomplete", next === "register" ? "new-password" : "current-password");
    }
  }

  // The shell can re-dispatch DOMContentLoaded; wiring must be idempotent, so
  // a second boot adds no listeners (the same guard app.js uses).
  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    el.openAuth?.addEventListener("click", () => {
      if (el.form) el.form.hidden = false;
      if (el.openAuth) el.openAuth.hidden = true;
      el.email?.focus();
    });

    el.toggleMode?.addEventListener("click", () => {
      setFormMode(formMode === "signin" ? "register" : "signin");
    });

    el.form?.addEventListener("submit", submitAuth);
    el.signOut?.addEventListener("click", signOut);
    el.migrate?.addEventListener("click", migrate);

    // The auth state is the single source of truth: this section renders it
    // whenever it changes, whoever changed it.
    BM.subscribe((view, changed) => {
      if (!changed.length || changed.includes("auth")) render(view.auth);
    });

    render(BM.getState().auth);

    // The OAuth callback, when the provider sent the user back.
    completeRobloxCallback();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // No public API is exported on purpose: this page script wires itself and is
  // not consumed by anything else. An export nobody reads is dead weight, and
  // the dead-code audit enforces that.
})();
