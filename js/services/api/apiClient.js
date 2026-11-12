/* ==========================================================================
   BuildMind — services/api/apiClient.js
   The one place the frontend talks HTTP.

   This layer exists so that no renderer, no page script and no controller
   ever calls fetch() directly. Everything below it is presentation; everything
   above it is the backend.

   Contract with the rest of the app:
     * every method resolves to the contracts.js envelope
       ({ ok: true, data }) or ({ ok: false, error: { type, message, ... } })
     * it never throws — a network failure becomes a `connection` failure
     * the backend's error codes and HTTP statuses are folded into the
       frontend's error vocabulary by services/api/errors.js, so the UI's
       copy rules do not need a second vocabulary

   Request lifecycle:
     * every request can be named, and its state is reported as
       idle → loading → success | error | cancelled
     * a request can be given a timeout and/or an external AbortSignal
     * an aborted request resolves with a `cancelled` failure, never a throw

   Security properties:
     * the session cookie is HttpOnly, so this file never touches a token
     * the CSRF token is kept in memory only (never localStorage), and is read
       from /auth/me or a successful login
     * a provider key, when supplied, goes in a POST body over HTTPS and is
       never put in a URL, a header or storage
     * an unexpected response body is never surfaced: only known backend codes
       contribute a message (see services/api/errors.js)
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const errors = BM.apiErrors;
  const { serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  /** How long a normal request may take before it is abandoned. */
  const DEFAULT_TIMEOUT_MS = 20000;

  // Deliberately NOT called `state`: js/state.js is the single owner of app
  // state, and this is transport configuration, not UI state.
  const clientState = {
    /** '' means "same origin", which is the production layout. */
    baseUrl: "",
    /** In-memory only. Never written to storage. */
    csrfToken: "",
    /** True once a session is known to exist. */
    authenticated: false,
    /** Configuration comes from app config; see configure(). */
    configured: false,
    /** Default per-request timeout in milliseconds. */
    timeoutMs: DEFAULT_TIMEOUT_MS,
    /** name → { status, startedAt, finishedAt, error } */
    requests: new Map(),
    /** Increments on every request; used to correlate a failure with its call. */
    sequence: 0,
  };

  /** Callbacks fired when a request discovers the session is gone. */
  const sessionExpiredListeners = new Set();
  /** Callbacks fired when any request changes state. */
  const lifecycleListeners = new Set();

  function configure(options) {
    const input = options || {};
    if (typeof input.baseUrl === "string") {
      // Trailing slash removed so `${base}/api/v1/...` is well formed.
      clientState.baseUrl = input.baseUrl.replace(/\/+$/, "");
    }
    if (typeof input.timeout === "number" && input.timeout >= 0) {
      clientState.timeoutMs = input.timeout;
    }
    clientState.configured = true;
  }

  function url(path) {
    return `${clientState.baseUrl}${path}`;
  }

  /* ------------------------------------------------------------------------
     Request lifecycle
     ------------------------------------------------------------------------ */
  function setRequestState(name, status, error) {
    const entry = clientState.requests.get(name) || {};
    const next = {
      status,
      startedAt: entry.startedAt || Date.now(),
      finishedAt: status === "loading" ? 0 : Date.now(),
      error: error || null,
    };
    clientState.requests.set(name, next);
    lifecycleListeners.forEach((listener) => {
      try {
        listener(name, next);
      } catch (err) {
        console.error("[BuildMind] request listener failed", err);
      }
    });
    return next;
  }

  /** The state of one named request — 'idle' when it was never started. */
  function requestState(name) {
    const entry = clientState.requests.get(name);
    if (!entry) return { status: "idle", startedAt: 0, finishedAt: 0, error: null };
    return entry;
  }

  function onRequestState(listener) {
    if (typeof listener !== "function") return () => {};
    lifecycleListeners.add(listener);
    return () => lifecycleListeners.delete(listener);
  }

  function notifySessionExpired(error) {
    sessionExpiredListeners.forEach((listener) => {
      try {
        listener(error);
      } catch (err) {
        console.error("[BuildMind] session listener failed", err);
      }
    });
  }

  function onSessionExpired(listener) {
    if (typeof listener !== "function") return () => {};
    sessionExpiredListeners.add(listener);
    return () => sessionExpiredListeners.delete(listener);
  }

  /**
   * One request. `options.body` is JSON-encoded; `options.raw` skips JSON.
   * Credentials are always included: the session cookie is HttpOnly.
   */
  function request(method, path, options) {
    const opts = options || {};
    const name = opts.name || `${String(method).toUpperCase()} ${path}`;
    clientState.sequence += 1;

    const headers = { accept: "application/json" };

    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // State-changing requests carry the CSRF token. The backend rejects the
    // request if it is missing, so this is not merely defensive.
    if (method !== "GET" && method !== "HEAD" && clientState.csrfToken) {
      headers["x-csrf-token"] = clientState.csrfToken;
    }
    if (opts.headers) Object.assign(headers, opts.headers);

    // One controller owns the request: the timeout aborts through it, and an
    // external signal is forwarded into it. Both paths end in the same
    // `cancelled`/`timeout` failure, so no caller ever sees a throw.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    let timer = 0;
    let detachExternal = null;

    const timeoutMs =
      typeof opts.timeout === "number" ? opts.timeout : clientState.timeoutMs;

    if (controller && timeoutMs > 0) {
      timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    if (controller && opts.signal) {
      const external = opts.signal;
      if (external.aborted) {
        controller.abort();
      } else {
        const onAbort = () => controller.abort();
        external.addEventListener("abort", onAbort, { once: true });
        detachExternal = () => external.removeEventListener("abort", onAbort);
      }
    }

    setRequestState(name, "loading");

    const finish = (envelope) => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      if (detachExternal) detachExternal();
      detachExternal = null;
      const status = envelope.ok ? "success" : envelope.error.type === ERROR_TYPES.CANCELLED ? "cancelled" : "error";
      setRequestState(name, status, envelope.ok ? null : envelope.error);
      return envelope;
    };

    const init = {
      method,
      headers,
      credentials: "include",
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      ...(controller ? { signal: controller.signal } : {}),
    };

    return fetch(url(path), init)
      .then((response) => {
        // A request id, when the server provides one, is carried into the
        // error so a failure can be correlated with a server log line.
        const requestId =
          response && response.headers && typeof response.headers.get === "function"
            ? response.headers.get("x-request-id") || ""
            : "";

        if (opts.raw) {
          setRequestState(name, "success");
          if (timer) window.clearTimeout(timer);
          if (detachExternal) detachExternal();
          return response;
        }

        if (response.status === 204) {
          return finish(ok(null));
        }

        return response
          .json()
          .catch(() => null)
          .then((body) => {
            if (!response.ok || !body || body.ok !== true) {
              const error = errors.normalizeHttp({
                status: response.status,
                body,
                requestId,
              });
              // A 401 on a protected route means the session is gone. The
              // auth controller listens for this and clears the signed-in
              // state; nothing here decides what the user sees.
              if (errors.isSessionExpired(error) && error.code === "UNAUTHENTICATED") {
                notifySessionExpired(error);
              }
              return finish(fail(error.type, error.message, error));
            }
            return finish(ok(body.data === undefined ? null : body.data));
          });
      })
      .catch((err) => {
        if (timedOut) {
          const error = errors.normalizeClient("TIMEOUT");
          return finish(fail(error.type, error.message, error));
        }
        // An abort is a cancellation, not a failure to reach the server.
        if (err && (err.name === "AbortError" || err.code === 20)) {
          const error = errors.normalizeClient("ABORTED");
          return finish(fail(error.type, error.message, error));
        }
        // A network failure is a connection problem, never a validation one.
        const error = errors.normalizeClient("NETWORK");
        return finish(fail(error.type, error.message, error));
      });
  }

  /* ------------------------------------------------------------------------
     Auth
     ------------------------------------------------------------------------ */
  function adoptSession(data) {
    if (!data) return data;
    if (typeof data.csrfToken === "string") clientState.csrfToken = data.csrfToken;
    clientState.authenticated = Boolean(data.authenticated);
    return data;
  }

  function register(input) {
    return request("POST", "/api/v1/auth/register", { body: input, name: "auth.register" }).then((result) => {
      if (BM.isOk(result)) adoptSession(result.data);
      return result;
    });
  }

  function login(input) {
    return request("POST", "/api/v1/auth/login", { body: input, name: "auth.login" }).then((result) => {
      if (BM.isOk(result)) adoptSession(result.data);
      return result;
    });
  }

  function logout() {
    return request("POST", "/api/v1/auth/logout", { body: {}, name: "auth.logout" }).then((result) => {
      clientState.csrfToken = "";
      clientState.authenticated = false;
      return result;
    });
  }

  function me(options) {
    return request("GET", "/api/v1/auth/me", { name: "auth.me", ...(options || {}) }).then((result) => {
      if (BM.isOk(result)) adoptSession(result.data);
      return result;
    });
  }

  /* ------------------------------------------------------------------------
     Projects
     ------------------------------------------------------------------------ */
  function listProjects(query, options) {
    const params = new URLSearchParams();
    if (query && query.status) params.set("status", query.status);
    if (query && query.q) params.set("q", query.q);
    if (query && query.limit) params.set("limit", String(query.limit));
    if (query && query.cursor) params.set("cursor", query.cursor);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request("GET", `/api/v1/projects${suffix}`, {
      name: "projects.list",
      ...(options || {}),
    });
  }

  function getProject(id, options) {
    return request("GET", `/api/v1/projects/${encodeURIComponent(id)}`, {
      name: "projects.get",
      ...(options || {}),
    });
  }

  function createProject(input, options) {
    return request("POST", "/api/v1/projects", {
      body: input,
      name: "projects.create",
      ...(options || {}),
    });
  }

  function updateProject(id, patch, options) {
    return request("PATCH", `/api/v1/projects/${encodeURIComponent(id)}`, {
      body: patch,
      name: "projects.update",
      ...(options || {}),
    });
  }

  function deleteProject(id, options) {
    return request("DELETE", `/api/v1/projects/${encodeURIComponent(id)}`, {
      name: "projects.delete",
      ...(options || {}),
    });
  }

  /* ------------------------------------------------------------------------
     Builds
     ------------------------------------------------------------------------ */
  function createBuild(input, options) {
    // `apiKey` rides in the body over HTTPS. It is never appended to the URL.
    return request("POST", "/api/v1/builds", {
      body: input,
      name: "builds.create",
      ...(options || {}),
    });
  }

  function getBuild(id, options) {
    return request("GET", `/api/v1/builds/${encodeURIComponent(id)}`, {
      name: "builds.get",
      ...(options || {}),
    });
  }

  function cancelBuild(id, options) {
    return request("POST", `/api/v1/builds/${encodeURIComponent(id)}/cancel`, {
      body: {},
      name: "builds.cancel",
      ...(options || {}),
    });
  }

  function retryBuild(id, input, options) {
    return request("POST", `/api/v1/builds/${encodeURIComponent(id)}/retry`, {
      body: input || {},
      name: "builds.retry",
      ...(options || {}),
    });
  }

  function getBuildEvents(id, after, options) {
    const suffix = typeof after === "number" ? `?after=${after}` : "";
    return request("GET", `/api/v1/builds/${encodeURIComponent(id)}/events${suffix}`, {
      name: "builds.events",
      ...(options || {}),
    });
  }

  /** The SSE URL, used only by sseClient.js. */
  function buildStreamUrl(id, after) {
    const suffix = typeof after === "number" ? `?after=${after}` : "";
    return url(`/api/v1/builds/${encodeURIComponent(id)}/stream${suffix}`);
  }

  /* ------------------------------------------------------------------------
     AI providers
     ------------------------------------------------------------------------ */
  function listProviders(options) {
    return request("GET", "/api/v1/ai/providers", { name: "ai.providers", ...(options || {}) });
  }

  function listModels(provider, options) {
    return request("GET", `/api/v1/ai/providers/${encodeURIComponent(provider)}/models`, {
      name: "ai.models",
      ...(options || {}),
    });
  }

  function validateProvider(input, options) {
    return request("POST", "/api/v1/ai/validate", {
      body: input,
      name: "ai.validate",
      ...(options || {}),
    });
  }

  function forgetCredential(provider, options) {
    return request("DELETE", `/api/v1/ai/credentials/${encodeURIComponent(provider)}`, {
      name: "ai.forget",
      ...(options || {}),
    });
  }

  /* ------------------------------------------------------------------------
     Connections
     ------------------------------------------------------------------------ */
  function robloxStatus(options) {
    return request("GET", "/api/v1/roblox/status", { name: "roblox.status", ...(options || {}) });
  }

  function robloxConnect(options) {
    return request("POST", "/api/v1/roblox/connect", { body: {}, name: "roblox.connect", ...(options || {}) });
  }

  function robloxDisconnect(options) {
    return request("POST", "/api/v1/roblox/disconnect", { body: {}, name: "roblox.disconnect", ...(options || {}) });
  }

  function studioStatus(options) {
    return request("GET", "/api/v1/studio/status", { name: "studio.status", ...(options || {}) });
  }

  function health(options) {
    return request("GET", "/api/v1/health", { name: "health", ...(options || {}) });
  }

  Object.assign(BM, {
    api: {
      configure,
      state: clientState,
      request,
      requestState,
      onRequestState,
      onSessionExpired,
      // auth
      register,
      login,
      logout,
      me,
      // projects
      listProjects,
      getProject,
      createProject,
      updateProject,
      deleteProject,
      // builds
      createBuild,
      getBuild,
      cancelBuild,
      retryBuild,
      getBuildEvents,
      buildStreamUrl,
      // providers
      listProviders,
      listModels,
      validateProvider,
      forgetCredential,
      // connections
      robloxStatus,
      robloxConnect,
      robloxDisconnect,
      studioStatus,
      health,
    },
  });
})();
