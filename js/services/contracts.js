/* ==========================================================================
   BuildMind — services/contracts.js
   The one result convention every service uses.

   No service ever throws across its boundary and no service returns a bare
   boolean or a bare value. Every method resolves to an envelope:

     { ok: true,  data: ... }                       success
     { ok: false, error: { type, message, ... } }   expected failure

   `error.type` is one of ERROR_TYPES below, so the UI can decide what to say
   without knowing which service answered. Internal stack traces never leave
   this module — only the short, user-safe message does.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  /** The only failure categories the frontend recognises. */
  const ERROR_TYPES = {
    VALIDATION: "validation",
    CONNECTION: "connection",
    CONFIGURATION: "configuration",
    OPERATION: "operation",
    CANCELLED: "cancelled",
    UNKNOWN: "unknown",
  };

  /** Short, user-safe copy per category. Never technical. */
  const ERROR_MESSAGES = {
    validation: "Some details need attention.",
    connection: "The connection was not available.",
    configuration: "Those settings are not ready yet.",
    operation: "Something went wrong.",
    cancelled: "The build was stopped.",
    unknown: "Something went wrong.",
  };

  const VALID_TYPES = Object.keys(ERROR_TYPES).map((key) => ERROR_TYPES[key]);

  function ok(data) {
    return { ok: true, data: data === undefined ? null : data };
  }

  /**
   * @param {string} type one of ERROR_TYPES
   * @param {string} [message] user-safe copy; falls back to the category text
   * @param {object} [extra] optional structured detail (e.g. field errors)
   */
  function fail(type, message, extra) {
    return {
      ok: false,
      error: {
        type: VALID_TYPES.indexOf(type) === -1 ? ERROR_TYPES.UNKNOWN : type,
        message: typeof message === "string" && message ? message : ERROR_MESSAGES[type] || ERROR_MESSAGES.unknown,
        ...(extra || {}),
      },
    };
  }

  function isOk(result) {
    return Boolean(result && result.ok === true);
  }

  function isFail(result) {
    return Boolean(result && result.ok === false);
  }

  /** Read `result.data.x` safely, with a fallback for failed envelopes. */
  function valueOf(result, key, fallback) {
    if (!isOk(result)) return fallback;
    if (key === undefined) return result.data;
    return result.data && key in result.data ? result.data[key] : fallback;
  }

  /**
   * Wrap a service implementation so every method:
   *   - returns a promise (uniform, even for local work)
   *   - never throws (unexpected throws become `unknown` failures)
   *   - keeps its name for debugging
   * Methods whose name starts with `_` are private and left untouched.
   */
  function createService(name, implementation) {
    const service = { name, mode: implementation.mode || "local" };

    Object.keys(implementation).forEach((key) => {
      if (key === "mode") return;

      // Underscore-prefixed hooks stay synchronous and unwrapped (test-only).
      if (key.charAt(0) === "_") {
        const hook = implementation[key];
        if (typeof hook === "function") service[key] = (...args) => hook.apply(service, args);
        return;
      }

      const method = implementation[key];
      if (typeof method !== "function") return;

      // Subscriptions are wiring, not operations: they must return their
      // unsubscribe function synchronously, so they are not wrapped.
      if (key === "subscribe") {
        service[key] = (listener) => method.call(service, listener);
        return;
      }

      service[key] = function wrapped(...args) {
        let result;
        try {
          result = method.apply(service, args);
        } catch (err) {
          // A thrown error is a bug, not a user-facing outcome: report the
          // category only, so nothing internal reaches the UI.
          return Promise.resolve(fail(ERROR_TYPES.UNKNOWN));
        }

        return Promise.resolve(result).catch(() => fail(ERROR_TYPES.UNKNOWN));
      };
    });

    return service;
  }

  Object.assign(BM, {
    ERROR_TYPES,
    ERROR_MESSAGES,
    serviceOk: ok,
    serviceFail: fail,
    isOk,
    isFail,
    valueOf,
    createService,
  });
})();
