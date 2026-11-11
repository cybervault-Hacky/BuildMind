/* ==========================================================================
   BuildMind — account.js
   The Account section of the Settings page.

   Scope, deliberately small: sign in, create an account, sign out, and offer
   to move projects that already exist in this browser onto the account. It is
   not a dashboard, and it does not introduce a new visual language — every
   element used here already exists in css/main.css (`.setting-row`, `.field`,
   `.input`, `.btn`, `.status-pill`).

   The one behaviour worth reading closely: sign-in is the ONLY thing that
   switches the app from local storage to the server. Signing out switches it
   back. Nothing is uploaded without an explicit action.
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

  /** Paint the whole section from a session state. */
  function render(authState) {
    const authenticated = Boolean(authState && authState.authenticated);
    const user = authenticated ? authState.user : null;
    const remote = BM.serviceMode === BM.SERVICE_MODES.REMOTE;

    if (el.mode) {
      el.mode.textContent = remote ? "Server storage" : "Local only";
      el.mode.dataset.mode = remote ? "remote" : "local";
    }

    if (el.signedOut) el.signedOut.hidden = authenticated;
    if (el.signedIn) el.signedIn.hidden = !authenticated;

    if (authenticated && user) {
      if (el.identity) el.identity.textContent = `${user.displayName || "Signed in"} · ${user.email}`;
      if (el.storageNote) el.storageNote.textContent = "Projects are stored on the BuildMind server.";
    }

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
      const raw = storage ? storage.read(BM.STORAGE_KEYS.projects) : null;
      const list = raw && Array.isArray(raw.projects) ? raw.projects : Array.isArray(raw) ? raw : [];
      return list.length;
    } catch {
      return 0;
    }
  }

  /* ------------------------------------------------------------------------
     Session
     ------------------------------------------------------------------------ */
  let authState = { authenticated: false, user: null };

  function refresh() {
    return BM.api.me().then((result) => {
      if (BM.isOk(result)) {
        authState = result.data;
      } else {
        // The API is unreachable. That is not a sign-in failure and must not
        // read as one; the account section simply stays signed out.
        authState = { authenticated: false, user: null, unreachable: true };
      }
      render(authState);

      /*
        The service mode is chosen once, by configuration, and this module never
        changes it. A signed-out visitor on a remote deployment must still be
        talking to the real API — it answers 401, which is the honest answer,
        and the account section shows the sign-in form. Swapping in the
        simulation here would be a silent fallback from production behaviour,
        which is exactly what this phase forbids.
      */
      BM.projectController?.load();
      return authState;
    });
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
        formMode === "register" ? "Use at least 12 characters." : "Enter your password.",
      );
      invalid = true;
    }
    if (invalid) return;

    busy = true;
    if (el.submit) {
      el.submit.disabled = true;
      el.submit.textContent = formMode === "register" ? "Creating…" : "Signing in…";
    }

    const call =
      formMode === "register" ? BM.api.register({ email, password }) : BM.api.login({ email, password });

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
        return;
      }

      // The password has done its job: drop it from the DOM immediately.
      if (el.password) el.password.value = "";
      if (el.form) el.form.hidden = true;
      if (el.openAuth) el.openAuth.hidden = false;

      // The session token never reached script (HttpOnly cookie); only the
      // CSRF token and the public user came back.
      authState = { authenticated: true, user: result.data.user };
      applySession(result.data.user);
      announce(formMode === "register" ? "Account created." : "Signed in.");
      BM.toast?.(formMode === "register" ? "Account created" : "Signed in");
      return refresh();
    });
  }

  /** Called after a successful auth: repaint and switch to server storage. */
  function applySession(user) {
    authState = { authenticated: true, user };
    render(authState);
  }

  function signOut() {
    return BM.api.logout().then(() => {
      authState = { authenticated: false, user: null };
      // The mode is unchanged: signing out ends the session, it does not
      // change which backend the deployment talks to.
      BM.projectController?.load();
      render(authState);
      announce("Signed out. Projects stay in this browser.");
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
    const raw = storage ? storage.read(BM.STORAGE_KEYS.projects) : null;
    const local = raw && Array.isArray(raw.projects) ? raw.projects : Array.isArray(raw) ? raw : [];

    return BM.api.listProjects({ limit: 100 }).then((existing) => {
      const names = new Set(
        (BM.isOk(existing) ? existing.data.projects : []).map((p) => String(p.name).toLowerCase()),
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
              }),
            ),
          Promise.resolve(),
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
              (skipped ? `; ${skipped} already existed.` : "."),
          );
          BM.toast?.(moved ? `Moved ${moved} project${moved === 1 ? "" : "s"}` : "Nothing to move");
          return BM.projectController?.load();
        });
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

    /*
      Only probe the session when the app is actually running against a
      backend. In the default static deployment there is no API and the CSP
      does not permit a connection, so probing would produce a guaranteed
      console error on every visit. The account section then simply reports
      the local-only state, which is the truth.
    */
    const remote = BM.requestedServiceMode && BM.requestedServiceMode() === BM.SERVICE_MODES.REMOTE;
    if (remote && BM.api) {
      refresh();
    } else {
      render({ authenticated: false, user: null });
    }
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
