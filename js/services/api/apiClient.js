/* ==========================================================================
   BuildMind — services/api/apiClient.js
   The one place the frontend talks HTTP.

   This layer exists so that no renderer, no page script and no controller
   ever calls fetch() directly. Everything below it is presentation; everything
   above it is the backend.

   Contract with the rest of the app:
     * every method resolves to the contracts.js envelope
       ({ ok: true, data }) or ({ ok: false, error: { type, message } })
     * it never throws — a network failure becomes a `connection` failure
     * the backend's error codes are folded into the frontend's existing
       ERROR_TYPES, so the UI's copy rules do not need a second vocabulary

   Security properties:
     * the session cookie is HttpOnly, so this file never touches a token
     * the CSRF token is kept in memory only (never localStorage), and is read
       from /auth/me or a successful login
     * a provider key, when supplied, goes in a POST body over HTTPS and is
       never put in a URL, a header or storage
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;

  /** Backend error code → frontend error type. */
  const CODE_TO_TYPE = {
    VALIDATION_ERROR: ERROR_TYPES.VALIDATION,
    UNAUTHENTICATED: ERROR_TYPES.CONFIGURATION,
    FORBIDDEN: ERROR_TYPES.CONFIGURATION,
    NOT_FOUND: ERROR_TYPES.VALIDATION,
    CONFLICT: ERROR_TYPES.OPERATION,
    RATE_LIMITED: ERROR_TYPES.OPERATION,
    PAYLOAD_TOO_LARGE: ERROR_TYPES.VALIDATION,
    CONFIGURATION_ERROR: ERROR_TYPES.CONFIGURATION,
    PROVIDER_UNAVAILABLE: ERROR_TYPES.CONNECTION,
    PROVIDER_AUTH_FAILED: ERROR_TYPES.CONFIGURATION,
    PROVIDER_TIMEOUT: ERROR_TYPES.CONNECTION,
    PROVIDER_RATE_LIMITED: ERROR_TYPES.OPERATION,
    PROVIDER_INVALID_OUTPUT: ERROR_TYPES.OPERATION,
    BUILD_FAILED: ERROR_TYPES.OPERATION,
    BUILD_CANCELLED: ERROR_TYPES.CANCELLED,
    BUILD_CONFLICT: ERROR_TYPES.OPERATION,
    BUILD_TIMEOUT: ERROR_TYPES.OPERATION,
    VALIDATION_INCOMPLETE: ERROR_TYPES.VALIDATION,
    ROBLOX_UNAVAILABLE: ERROR_TYPES.CONNECTION,
    ROBLOX_NOT_CONFIGURED: ERROR_TYPES.CONFIGURATION,
    STUDIO_UNAVAILABLE: ERROR_TYPES.CONNECTION,
    STUDIO_UNAUTHORIZED: ERROR_TYPES.CONFIGURATION,
    STUDIO_PROTOCOL_ERROR: ERROR_TYPES.OPERATION,
    INTERNAL_ERROR: ERROR_TYPES.UNKNOWN,
  };

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
  };

  function configure(options) {
    const input = options || {};
    if (typeof input.baseUrl === "string") {
      // Trailing slash removed so `${base}/api/v1/...` is well formed.
      clientState.baseUrl = input.baseUrl.replace(/\/+$/, "");
    }
    clientState.configured = true;
  }

  function url(path) {
    return `${clientState.baseUrl}${path}`;
  }

  /** Fold a backend error body into the frontend envelope. */
  function toFailure(status, body) {
    const error = body && body.error ? body.error : null;
    const code = error && error.code ? error.code : "INTERNAL_ERROR";
    const type = CODE_TO_TYPE[code] || ERROR_TYPES.UNKNOWN;

    // The backend's message is already user-safe; keep it, but never invent one.
    return fail(type, error && error.message ? error.message : "", {
      code,
      status,
      fields: error && error.fields ? error.fields : {},
    });
  }

  /**
   * One request. `options.body` is JSON-encoded; `options.raw` skips JSON.
   * Credentials are always included: the session cookie is HttpOnly.
   */
  function request(method, path, options) {
    const opts = options || {};
    const headers = { accept: "application/json" };

    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // State-changing requests carry the CSRF token. The backend rejects the
    // request if it is missing, so this is not merely defensive.
    if (method !== "GET" && method !== "HEAD" && clientState.csrfToken) {
      headers["x-csrf-token"] = clientState.csrfToken;
    }
    if (opts.headers) Object.assign(headers, opts.headers);

    return fetch(url(path), {
      method,
      headers,
      credentials: "include",
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    })
      .then((response) => {
        if (opts.raw) return response;

        return response
          .json()
          .catch(() => null)
          .then((body) => {
            if (!response.ok || !body || body.ok !== true) {
              return toFailure(response.status, body);
            }
            return ok(body.data);
          });
      })
      .catch((err) => {
        // A network failure is a connection problem, never a validation one.
        return fail(ERROR_TYPES.CONNECTION, "", { code: "NETWORK", cause: String(err && err.message) });
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
    return request("POST", "/api/v1/auth/register", { body: input }).then((result) => {
      if (BM.isOk(result)) adoptSession(result.data);
      return result;
    });
  }

  function login(input) {
    return request("POST", "/api/v1/auth/login", { body: input }).then((result) => {
      if (BM.isOk(result)) adoptSession(result.data);
      return result;
    });
  }

  function logout() {
    return request("POST", "/api/v1/auth/logout", { body: {} }).then((result) => {
      clientState.csrfToken = "";
      clientState.authenticated = false;
      return result;
    });
  }

  function me() {
    return request("GET", "/api/v1/auth/me").then((result) => {
      if (BM.isOk(result)) adoptSession(result.data);
      return result;
    });
  }

  /* ------------------------------------------------------------------------
     Projects
     ------------------------------------------------------------------------ */
  function listProjects(query) {
    const params = new URLSearchParams();
    if (query && query.status) params.set("status", query.status);
    if (query && query.q) params.set("q", query.q);
    if (query && query.limit) params.set("limit", String(query.limit));
    if (query && query.cursor) params.set("cursor", query.cursor);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request("GET", `/api/v1/projects${suffix}`);
  }

  function getProject(id) {
    return request("GET", `/api/v1/projects/${encodeURIComponent(id)}`);
  }

  function createProject(input) {
    return request("POST", "/api/v1/projects", { body: input });
  }

  function updateProject(id, patch) {
    return request("PATCH", `/api/v1/projects/${encodeURIComponent(id)}`, { body: patch });
  }

  function deleteProject(id) {
    return request("DELETE", `/api/v1/projects/${encodeURIComponent(id)}`);
  }

  /* ------------------------------------------------------------------------
     Builds
     ------------------------------------------------------------------------ */
  function createBuild(input) {
    // `apiKey` rides in the body over HTTPS. It is never appended to the URL.
    return request("POST", "/api/v1/builds", { body: input });
  }

  function getBuild(id) {
    return request("GET", `/api/v1/builds/${encodeURIComponent(id)}`);
  }

  function cancelBuild(id) {
    return request("POST", `/api/v1/builds/${encodeURIComponent(id)}/cancel`, { body: {} });
  }

  function retryBuild(id, input) {
    return request("POST", `/api/v1/builds/${encodeURIComponent(id)}/retry`, { body: input || {} });
  }

  function getBuildEvents(id, after) {
    const suffix = typeof after === "number" ? `?after=${after}` : "";
    return request("GET", `/api/v1/builds/${encodeURIComponent(id)}/events${suffix}`);
  }

  /** The SSE URL, used only by buildStream.js. */
  function buildStreamUrl(id, after) {
    const suffix = typeof after === "number" ? `?after=${after}` : "";
    return url(`/api/v1/builds/${encodeURIComponent(id)}/stream${suffix}`);
  }

  /* ------------------------------------------------------------------------
     AI providers
     ------------------------------------------------------------------------ */
  function listProviders() {
    return request("GET", "/api/v1/ai/providers");
  }

  function listModels(provider) {
    return request("GET", `/api/v1/ai/providers/${encodeURIComponent(provider)}/models`);
  }

  function validateProvider(input) {
    return request("POST", "/api/v1/ai/validate", { body: input });
  }

  function forgetCredential(provider) {
    return request("DELETE", `/api/v1/ai/credentials/${encodeURIComponent(provider)}`);
  }

  /* ------------------------------------------------------------------------
     Connections
     ------------------------------------------------------------------------ */
  function robloxStatus() {
    return request("GET", "/api/v1/roblox/status");
  }

  function robloxConnect() {
    return request("POST", "/api/v1/roblox/connect", { body: {} });
  }

  function robloxDisconnect() {
    return request("POST", "/api/v1/roblox/disconnect", { body: {} });
  }

  function studioStatus() {
    return request("GET", "/api/v1/studio/status");
  }

  function health() {
    return request("GET", "/api/v1/health");
  }

  Object.assign(BM, {
    api: {
      configure,
      state: clientState,
      request,
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
