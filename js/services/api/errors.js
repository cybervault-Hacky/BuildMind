/* ==========================================================================
   BuildMind — services/api/errors.js
   The one place a backend failure becomes a UI-safe error.

   Everything the frontend knows about failure lives here:
     * the backend error codes it understands
     * the HTTP status → frontend error type mapping
     * the safe copy shown to the user for each status
     * the rules that keep an unsafe detail out of the DOM

   The rules:
     * a backend message is used only when the code is one this file knows.
       Anything else (a proxy's HTML error page, an unexpected body, a stack
       trace echoed by a misconfigured gateway) is replaced by our own copy.
     * a 5xx never shows a server message: the server's own text is for the
       server, and the user gets one honest sentence.
     * no error object ever carries a stack, a SQL fragment, a file path or a
       credential. Field-level validation text is the one exception, because
       it is written by our own backend's Zod schemas and names a field, not
       a secret.

   This module has no dependencies beyond `window.BuildMind`, so it can be
   loaded (and unit-tested) on its own.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  /** The frontend's failure categories. Mirrors services/contracts.js. */
  const ERROR_TYPES = {
    VALIDATION: "validation",
    CONNECTION: "connection",
    CONFIGURATION: "configuration",
    OPERATION: "operation",
    CANCELLED: "cancelled",
    UNKNOWN: "unknown",
  };

  /**
   * The backend's error codes (backend/src/errors/AppError.ts). A code that is
   * not in this list never contributes a message to the UI.
   */
  const BACKEND_CODES = {
    VALIDATION_ERROR: "validation",
    UNAUTHENTICATED: "configuration",
    FORBIDDEN: "configuration",
    NOT_FOUND: "validation",
    CONFLICT: "operation",
    RATE_LIMITED: "operation",
    PAYLOAD_TOO_LARGE: "validation",
    CONFIGURATION_ERROR: "configuration",
    PROVIDER_UNAVAILABLE: "connection",
    PROVIDER_AUTH_FAILED: "configuration",
    PROVIDER_TIMEOUT: "connection",
    PROVIDER_RATE_LIMITED: "operation",
    PROVIDER_INVALID_OUTPUT: "operation",
    BUILD_FAILED: "operation",
    BUILD_CANCELLED: "cancelled",
    BUILD_CONFLICT: "operation",
    BUILD_TIMEOUT: "operation",
    VALIDATION_INCOMPLETE: "operation",
    ROBLOX_UNAVAILABLE: "connection",
    ROBLOX_NOT_CONFIGURED: "configuration",
    STUDIO_UNAVAILABLE: "connection",
    STUDIO_UNAUTHORIZED: "configuration",
    STUDIO_PROTOCOL_ERROR: "validation",
    INTERNAL_ERROR: "unknown",
  };

  /** HTTP status → frontend error type. The fallback is `unknown`. */
  const STATUS_TO_TYPE = {
    400: ERROR_TYPES.VALIDATION,
    401: ERROR_TYPES.CONFIGURATION,
    403: ERROR_TYPES.CONFIGURATION,
    404: ERROR_TYPES.VALIDATION,
    409: ERROR_TYPES.OPERATION,
    413: ERROR_TYPES.VALIDATION,
    422: ERROR_TYPES.VALIDATION,
    429: ERROR_TYPES.OPERATION,
    500: ERROR_TYPES.UNKNOWN,
    502: ERROR_TYPES.CONNECTION,
    503: ERROR_TYPES.CONNECTION,
    504: ERROR_TYPES.CONNECTION,
  };

  /** HTTP status → safe copy. Used whenever the backend's own text is absent. */
  const STATUS_TO_MESSAGE = {
    400: "That request could not be read.",
    401: "Please sign in to continue.",
    403: "You do not have access to that.",
    404: "That item could not be found.",
    409: "That change conflicts with the current state.",
    413: "That request is too large.",
    422: "Some details need attention.",
    429: "Too many requests. Try again shortly.",
    500: "Something went wrong.",
    502: "The service is not reachable right now.",
    503: "The service is not available right now.",
    504: "The service took too long to respond.",
  };

  /** Client-side failure codes that never come from the backend. */
  const CLIENT_CODES = {
    NETWORK: "connection",
    TIMEOUT: "connection",
    ABORTED: "cancelled",
    MALFORMED_RESPONSE: "unknown",
  };

  const CLIENT_MESSAGES = {
    NETWORK: "The service could not be reached.",
    TIMEOUT: "The service took too long to respond.",
    ABORTED: "The request was cancelled.",
    MALFORMED_RESPONSE: "The service returned an unexpected response.",
  };

  /** Longest message ever shown. A paragraph at most. */
  const MAX_MESSAGE = 240;

  /**
   * Strip anything that looks like internal detail.
   *
   * This is a backstop, not the main defence: the backend already returns
   * safe copy. It exists so a misconfigured proxy or a future endpoint that
   * echoes an error body cannot put a stack trace on screen.
   */
  function sanitize(message) {
    if (typeof message !== "string") return "";
    let text = message.trim();
    if (!text) return "";

    // Multi-line output is a log, not a sentence.
    text = text.split(/\r?\n/)[0].trim();

    // Anything that looks like a path, a stack frame, SQL or a URL is dropped.
    if (/(\/[\w.-]+){2,}/.test(text)) return "";
    if (/\b(at\s+\S+\s+\(|Error:|Exception:|Traceback|node_modules|SQLSTATE|select\s+.*\s+from\b)/i.test(text)) {
      return "";
    }
    if (/^https?:\/\//i.test(text)) return "";

    if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE).trim() + "…";
    return text;
  }

  /** Field errors are named by our own schemas; keep them, but only strings. */
  function sanitizeFields(fields) {
    if (!fields || typeof fields !== "object") return {};
    const out = {};
    Object.keys(fields).forEach((key) => {
      const value = fields[key];
      if (typeof value !== "string") return;
      const safe = sanitize(value);
      if (safe) out[key] = safe;
    });
    return out;
  }

  function makeError(type, message, extra) {
    return {
      type: type || ERROR_TYPES.UNKNOWN,
      message: message || "Something went wrong.",
      ...(extra || {}),
    };
  }

  /**
   * Turn an HTTP failure into a safe error object.
   *
   * @param {{status:number, body:any, requestId?:string}} input
   * @returns {object} an error object (not an envelope)
   */
  function normalizeHttp(input) {
    const status = Number(input && input.status) || 0;
    const body = input && input.body ? input.body : null;
    const requestId = input && input.requestId ? String(input.requestId) : "";

    const rawError = body && typeof body === "object" && body.error ? body.error : null;
    const code = rawError && typeof rawError.code === "string" ? rawError.code : "";
    const known = Object.prototype.hasOwnProperty.call(BACKEND_CODES, code);

    const type = known
      ? BACKEND_CODES[code]
      : STATUS_TO_TYPE[status] || ERROR_TYPES.UNKNOWN;

    // A 5xx never borrows the server's wording: the server's text is for the
    // server. A 4xx may, because our own backend writes those by hand.
    let message = "";
    if (known && status < 500 && rawError && typeof rawError.message === "string") {
      message = sanitize(rawError.message);
    }
    if (!message) {
      message = STATUS_TO_MESSAGE[status] || (status >= 500 ? "Something went wrong." : "");
    }
    if (!message) message = "Something went wrong.";

    return makeError(type, message, {
      code: code || (status ? `HTTP_${status}` : "UNKNOWN"),
      status,
      ...(known ? {} : { backendCode: code || null }),
      fields: sanitizeFields(rawError && rawError.fields),
      retryable: status === 0 || status === 429 || status >= 500,
      ...(requestId ? { requestId } : {}),
    });
  }

  /** A client-side failure that never reached (or never came back from) the API. */
  function normalizeClient(code, message, extra) {
    const type = CLIENT_CODES[code] || ERROR_TYPES.UNKNOWN;
    return makeError(type, message || CLIENT_MESSAGES[code] || "Something went wrong.", {
      code,
      status: 0,
      retryable: code === "NETWORK" || code === "TIMEOUT",
      ...(extra || {}),
    });
  }

  /** The envelope every service returns. */
  function fail(error) {
    return { ok: false, error };
  }

  function ok(data) {
    return { ok: true, data: data === undefined ? null : data };
  }

  /** True when the error means the session is gone. */
  function isSessionExpired(error) {
    if (!error) return false;
    return error.status === 401 || error.code === "UNAUTHENTICATED";
  }

  Object.assign(BM, {
    apiErrors: {
      ERROR_TYPES,
      BACKEND_CODES,
      STATUS_TO_TYPE,
      STATUS_TO_MESSAGE,
      CLIENT_CODES,
      normalizeHttp,
      normalizeClient,
      fail,
      ok,
      isSessionExpired,
      sanitize,
    },
  });
})();
