/* ==========================================================================
   BuildMind — services/api/sseClient.js
   The one place the frontend opens an EventSource.

   Why a dedicated client rather than an inline EventSource in a service:
     * exactly one stream may exist per logical stream (a build run). Opening
       a second one is a bug, so the client refuses to: it closes the old
       handle first and keeps a registry of the live ones.
     * every stream can be closed, and closing is idempotent. A closed stream
       never fires another callback, so a late frame cannot repaint the UI.
     * a stream that stops delivering is reported as a failure instead of
       hanging the UI in "connecting" forever.

   The client is deliberately dumb about build semantics. It moves frames and
   reports lifecycle events; deciding whether a frame belongs to the run that
   is on screen is the service's job (see services/ai/remoteAIService.js).

   Security: the stream URL is built by the API client and carries no
   credential — the session travels in the HttpOnly cookie, which is why the
   stream is opened with `withCredentials`.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  /** How long a stream may deliver nothing before it is treated as failed. */
  const DEFAULT_IDLE_TIMEOUT_MS = 60000;

  /** live streams, keyed by the caller's id. */
  const streams = new Map();

  function now() {
    return Date.now();
  }

  /**
   * Open a stream.
   *
   * @param {object} options
   * @param {string} options.id        a stable identity; a second stream with
   *                                   the same id closes the first
   * @param {string|function} options.url  the URL, or a function returning it
   *                                   (re-read on every reconnect, so `after`
   *                                   can advance)
   * @param {boolean} [options.withCredentials]
   * @param {function} [options.onOpen]
   * @param {function} [options.onEvent]  (frame) => void
   * @param {function} [options.onError]  ({ attempt, reason }) => void
   * @param {function} [options.onClose]  ({ reason }) => void
   * @param {number} [options.idleTimeoutMs]
   * @returns {{id:string, close:function, isClosed:function, isOpen:function}}
   */
  function create(options) {
    const opts = options || {};
    const id = String(opts.id || "stream");

    // One stream per id: the previous one is closed, never left running.
    const existing = streams.get(id);
    if (existing) existing.close("replaced");

    if (typeof window.EventSource !== "function") {
      // No EventSource at all: report it rather than pretending to stream.
      const error = { type: "connection", message: "Live updates are not available in this browser." };
      if (typeof opts.onError === "function") opts.onError({ attempt: 0, reason: "unsupported" });
      if (typeof opts.onClose === "function") opts.onClose({ reason: "unsupported" });
      return {
        id,
        close() {},
        isClosed: () => true,
        isOpen: () => false,
      };
    }

    const idleTimeoutMs =
      typeof opts.idleTimeoutMs === "number" ? opts.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;

    let source = null;
    let closed = false;
    let opened = false;
    let attempt = 0;
    let idleTimer = 0;
    let lastDelivery = 0;

    const handle = {
      id,
      close(reason) {
        if (closed) return;
        closed = true;
        if (idleTimer) window.clearTimeout(idleTimer);
        idleTimer = 0;
        if (source) {
          try {
            source.close();
          } catch {
            // Already closed.
          }
          source = null;
        }
        streams.delete(id);
        if (typeof opts.onClose === "function") opts.onClose({ reason: reason || "closed" });
      },
      isClosed: () => closed,
      isOpen: () => !closed && opened,
    };

    function resetIdleTimer() {
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        if (closed) return;
        if (typeof opts.onError === "function") opts.onError({ attempt, reason: "idle" });
        handle.close("idle");
      }, idleTimeoutMs);
    }

    function open() {
      if (closed) return;

      const target = typeof opts.url === "function" ? opts.url() : opts.url;
      if (!target) {
        handle.close("no-url");
        return;
      }

      let created;
      try {
        created = new window.EventSource(target, {
          withCredentials: opts.withCredentials !== false,
        });
      } catch {
        if (typeof opts.onError === "function") opts.onError({ attempt, reason: "unsupported" });
        handle.close("failed");
        return;
      }

      source = created;
      lastDelivery = now();

      created.onopen = () => {
        if (closed) return;
        opened = true;
        attempt = 0;
        resetIdleTimer();
        if (typeof opts.onOpen === "function") opts.onOpen({ attempt });
      };

      created.onmessage = (message) => {
        if (closed) return;
        lastDelivery = now();
        resetIdleTimer();

        let frame = null;
        try {
          frame = JSON.parse(message.data);
        } catch {
          // A frame we cannot read is dropped, not guessed at.
          return;
        }
        if (typeof opts.onEvent === "function") opts.onEvent(frame);
      };

      created.onerror = () => {
        if (closed) return;
        attempt += 1;
        const state = created.readyState;
        // EventSource reconnects on its own. The client only reports the
        // failure and gives up when the browser stops trying.
        if (typeof opts.onError === "function") {
          opts.onError({ attempt, reason: state === 2 ? "closed" : "network" });
        }
        if (state === 2) {
          // CLOSED: the browser will not retry. Reopen once, so a server
          // restart does not permanently kill the stream.
          if (attempt <= 3) {
            source = null;
            window.setTimeout(() => {
              if (closed) return;
              open();
            }, 250 * attempt);
            return;
          }
          handle.close("failed");
        }
      };
    }

    streams.set(id, handle);
    open();
    return handle;
  }

  /** Close one stream by id. */
  function close(id, reason) {
    const handle = streams.get(id);
    if (!handle) return false;
    handle.close(reason || "closed");
    return true;
  }

  /** Close every stream. Used when a page is torn down. */
  function closeAll(reason) {
    Array.from(streams.keys()).forEach((key) => close(key, reason || "closed"));
  }

  Object.assign(BM, {
    sse: {
      create,
      close,
      closeAll,
      activeCount: () => streams.size,
      activeIds: () => Array.from(streams.keys()),
    },
  });
})();
