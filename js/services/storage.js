/* ==========================================================================
   BuildMind — services/storage.js
   The only place the frontend touches localStorage.

   Everything persisted here is non-sensitive UI preference or clearly local
   sample data. The complete, audited list of keys:

     buildmind.settings.v1     { provider, model, autoFix, hints }
     buildmind.preferences.v1  { motion }
     buildmind.connections.v1  { roblox: boolean, studio: boolean }
     buildmind.projects.v1     [ { id, name, status, updated, art, scene } ]
     buildmind.draft.v1        { prompt }

   Never persisted, by design: API keys, tokens, passwords, session secrets,
   account identifiers or anything that could authenticate a request. The API
   key exists only as an in-memory "present" flag.

   Services own reads/writes for their own keys; the store never persists
   anything itself. If storage is unavailable (private mode, quota) every read
   falls back and every write is a no-op, so the app keeps working in memory.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  const KEYS = {
    settings: "buildmind.settings.v1",
    preferences: "buildmind.preferences.v1",
    connections: "buildmind.connections.v1",
    projects: "buildmind.projects.v1",
    draft: "buildmind.draft.v1",
  };

  /** Keys that must never appear in storage — used by the security check. */
  const FORBIDDEN_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization)/i;

  function store() {
    try {
      return window.localStorage;
    } catch (err) {
      return null;
    }
  }

  function available() {
    const ls = store();
    if (!ls) return false;
    try {
      const probe = "__buildmind_probe__";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  }

  function readJSON(key) {
    const ls = store();
    if (!ls) return undefined;
    let raw;
    try {
      raw = ls.getItem(key);
    } catch (err) {
      return undefined;
    }
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch (err) {
      // Corrupt payload: behave as if nothing was stored rather than throwing.
      return undefined;
    }
  }

  /** Objects only; anything else (arrays, scalars) is treated as missing. */
  function readObject(key, fallback) {
    const value = readJSON(key);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...fallback, ...value };
    }
    return { ...fallback };
  }

  /** Arrays only. Returns null when nothing usable is stored. */
  function readArray(key) {
    const value = readJSON(key);
    return Array.isArray(value) ? value : null;
  }

  function write(key, value) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      // A guarded guard: sensitive names are refused at the adapter level,
      // without echoing the key it refused.
      console.warn("[BuildMind] blocked a sensitive storage write");
      return false;
    }
    const ls = store();
    if (!ls) return false;
    try {
      ls.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      // Quota or private mode: the app continues with in-memory state only.
      return false;
    }
  }

  function remove(key) {
    const ls = store();
    if (!ls) return false;
    try {
      ls.removeItem(key);
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Keys currently stored, for the documented audit list and diagnostics. */
  function keys() {
    const ls = store();
    if (!ls) return [];
    try {
      return Object.keys(ls).sort();
    } catch (err) {
      return [];
    }
  }

  Object.assign(BM, {
    STORAGE_KEYS: KEYS,
    storage: { readJSON, readObject, readArray, write, remove, keys, available },
  });
})();
