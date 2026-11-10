/* ==========================================================================
   BuildMind — services/projects/localProjectService.js
   The project boundary. Today projects live in localStorage; a future
   `remoteProjectService` implements the same methods against a backend and the
   renderers do not change.

   Public surface (contracts.js envelopes, never throws):

     listProjects()              → { projects }
     getProject(id)              → { project }
     createProject(data)         → { project }
     updateProject(id, patch)    → { project }
     deleteProject(id)           → { id }
     recordBuild(input)          → { project, created, duplicate }
     markRun(id, outcome, runId) → { project }
     subscribe(listener)         → unsubscribe

   Shape of a project:

     {
       id, name, description, prompt,
       status,                    // draft | ready | building | testing | fixing
                                  // | validating | complete | stopped | error
       created, updatedAt,        // epoch ms
       lastBuildAt,               // epoch ms of the last *completed* build, 0 if none
       runId,                     // the run that last completed a build here
       art, scene, history[], sample?, simulated
     }

   Rules this file enforces:

     • `lastBuildAt` is only ever written by `recordBuild`. A stopped or failed
       run records its outcome in `history` and never touches it, so a project
       can never claim a build that did not finish.
     • `recordBuild` is idempotent on `runId`: the same run recorded twice
       returns the first result and changes nothing, so a duplicated completion
       event cannot create a second project.
     • Every read normalises what it finds. Malformed records are repaired in
       place (name, status, timestamps, prompt, art) instead of being trusted.

   Projects are local mock data. Nothing here publishes, uploads or syncs.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES, storage, STORAGE_KEYS } = BM;
  const model = BM.projectModel;

  const KEY = STORAGE_KEYS.projects;
  const MAX_NAME = 60;
  const NAME_FALLBACK = "Untitled game";
  const MAX_HISTORY = 12;

  /** The lifecycle the frontend can actually reach. Mirrors BUILD + draft. */
  const VALID_STATUS = [
    "draft",
    "ready",
    "building",
    "testing",
    "fixing",
    "validating",
    "complete",
    "stopped",
    "error",
  ];

  /** States a run may move through while it is in flight. */
  const RUN_STATUS = ["building", "testing", "fixing", "validating"];

  const SCENE_ARTS = ["lattice", "terrain", "graph", "plates", "dots", "arcs"];
  const EVENT_TYPES = ["created", "complete", "stopped", "error", "building"];

  const listeners = new Set();

  function emit(projects) {
    listeners.forEach((listener) => {
      try {
        listener(projects.slice());
      } catch (err) {
        console.error("[BuildMind] project listener failed", err);
      }
    });
  }

  /* ------------------------------------------------------------------------
     Input safety — names, descriptions and prompts are user-controlled
     strings. They are stored as plain text and only ever written to the DOM
     through textContent, so they are never interpreted as HTML. Trimming and
     length-capping here keeps the stored data predictable.
     ------------------------------------------------------------------------ */
  function safeText(value, max) {
    // Only text-ish primitives are real text. An object would stringify to
    // "[object Object]" and a number to "42"; neither is a name a user typed,
    // so both are treated as "no value" and fall back to the honest default.
    if (typeof value === "string") {
      return value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
    return "";
  }

  function safeName(value) {
    return safeText(value, MAX_NAME) || NAME_FALLBACK;
  }

  function normalizeStatus(value) {
    return VALID_STATUS.indexOf(value) === -1 ? "draft" : value;
  }

  function stamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function artForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    return { art: SCENE_ARTS[hash % SCENE_ARTS.length], scene: hash % 6 };
  }

  function newId() {
    return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function normalizeHistory(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry) => entry && EVENT_TYPES.indexOf(entry.type) !== -1 && stamp(entry.at))
      .slice(-MAX_HISTORY)
      .map((entry) => ({
        type: entry.type,
        at: stamp(entry.at),
        ...(entry.runId ? { runId: String(entry.runId).slice(0, 40) } : {}),
      }));
  }

  /**
   * Repair one stored record. Anything missing is filled with an honest
   * default; nothing that could be a build claim is invented. `index` only
   * feeds a deterministic fallback id for a record that lost its own.
   */
  function normalizeProject(raw, index) {
    const input = raw && typeof raw === "object" ? raw : {};
    const name = safeName(input.name);
    const prompt = model.safePrompt(input.prompt);
    const fallbackArt = artForName(name);

    // Older records stored a relative label ("2 days ago") instead of a time.
    const now = Date.now();
    const legacyUpdated = model.parseLegacyLabel(input.updated, now);
    const created = stamp(input.created) || legacyUpdated || stamp(input.updatedAt) || now;
    const updatedAt = stamp(input.updatedAt) || legacyUpdated || created;
    // A pre-lifecycle record said `lastBuild: true` and stored a relative
    // label. Its stored time was the build time, so it migrates to one instead
    // of being silently erased. Nothing newer than `updatedAt` is invented.
    const status0 = normalizeStatus(input.status);
    const legacyBuilt = input.lastBuild === true || status0 === "complete";
    const lastBuildAt = stamp(input.lastBuildAt) || (legacyBuilt ? stamp(input.updatedAt) || legacyUpdated || 0 : 0);

    const history = normalizeHistory(input.history);

    return {
      id: typeof input.id === "string" && input.id.trim()
        ? input.id.trim().slice(0, 64)
        : `recovered-${index}-${fallbackArt.scene}`,
      name,
      description: safeText(input.description, model.MAX_DESCRIPTION) || model.describeFromPrompt(prompt),
      prompt,
      status: status0,
      created,
      updatedAt: Math.max(updatedAt, created),
      lastBuildAt,
      runId: typeof input.runId === "string" ? input.runId.slice(0, 40) : "",
      art: SCENE_ARTS.indexOf(input.art) === -1 ? fallbackArt.art : input.art,
      scene: Number.isInteger(input.scene) && input.scene >= 0 && input.scene < SCENE_ARTS.length
        ? input.scene
        : fallbackArt.scene,
      history,
      simulated: true,
      ...(input.sample ? { sample: true } : {}),
    };
  }

  /** Read → normalise → drop only what is not a usable project record. */
  function read() {
    const stored = storage.readArray(KEY);
    if (stored === null) return null;
    return stored
      .filter((project) => project && typeof project === "object" && !Array.isArray(project))
      // A record with no id, name or prompt carries nothing a user could have
      // made (createProject always writes both), so it is corruption rather
      // than a project and is dropped instead of becoming "Untitled game".
      .filter((project) => project.id || project.name || project.prompt)
      .map((project, index) => normalizeProject(project, index));
  }

  function write(projects) {
    storage.write(KEY, projects);
    emit(projects);
  }

  /* ------------------------------------------------------------------------
     Sample data — only for a brand-new visitor. Once a list has been written
     (even an empty one) it is respected as the user's real list.

     They are labelled `sample: true` on the card, and only the two that show a
     completed state carry a last-build time. The others are honestly unbuilt.
     ------------------------------------------------------------------------ */
  function samples() {
    const now = Date.now();
    const hours = (count) => now - count * 3600000;
    const days = (count) => now - count * 86400000;

    const seeds = [
      {
        id: "sample-island",
        name: "Floating Island Survival",
        prompt: "Create a survival game on a floating island with resource gathering.",
        description: "Survival on floating islands with resource gathering",
        status: "complete",
        created: days(16),
        updatedAt: hours(5),
        lastBuildAt: hours(5),
        runId: "sample-run-island",
        art: "lattice",
        scene: 0,
        history: [{ type: "complete", at: hours(5) }],
        sample: true,
      },
      {
        id: "sample-obby",
        name: "Checkpoint Obby",
        prompt: "Make an obby with moving platforms, checkpoints and a timer.",
        description: "Obby with moving platforms, checkpoints and a timer",
        status: "ready",
        created: days(9),
        updatedAt: days(2),
        art: "terrain",
        scene: 1,
        sample: true,
      },
      {
        id: "sample-tycoon",
        name: "Dropper Tycoon",
        prompt: "Build a tycoon where players buy droppers and expand a base.",
        description: "Tycoon where players buy droppers and expand a base",
        status: "complete",
        created: days(24),
        updatedAt: days(6),
        lastBuildAt: days(6),
        runId: "sample-run-tycoon",
        art: "graph",
        scene: 2,
        history: [{ type: "complete", at: days(6) }],
        sample: true,
      },
      {
        id: "sample-arena",
        name: "Round-Based Arena",
        prompt: "Create a round-based arena with classes and a scoreboard.",
        description: "Round-based arena with classes and a scoreboard",
        status: "draft",
        created: days(30),
        updatedAt: days(30),
        art: "plates",
        scene: 3,
        sample: true,
      },
    ];

    return seeds.map((seed, index) => normalizeProject(seed, index));
  }

  function persist(projects, project, extra) {
    write(projects);
    return ok({ project: { ...project }, ...(extra || {}) });
  }

  /* ------------------------------------------------------------------------
     Reads
     ------------------------------------------------------------------------ */
  function listProjects() {
    const stored = read();
    if (stored === null) {
      const seeded = samples();
      write(seeded);
      return ok({ projects: seeded });
    }
    return ok({ projects: stored });
  }

  function getProject(id) {
    const stored = read() || [];
    const project = stored.find((item) => item.id === id);
    if (!project) return fail(ERROR_TYPES.VALIDATION, "That project could not be found.");
    return ok({ project: { ...project } });
  }

  /* ------------------------------------------------------------------------
     Writes
     ------------------------------------------------------------------------ */
  function createProject(data) {
    const input = data || {};
    const name = safeName(input.name);
    const prompt = model.safePrompt(input.prompt);
    const now = Date.now();

    const project = normalizeProject({
      id: input.id || newId(),
      name,
      description: input.description || model.describeFromPrompt(prompt),
      prompt,
      // A project created by hand starts as a draft; a project that arrived
      // with a stored status keeps it (the status is only ever set by us).
      status: input.status || (prompt ? "ready" : "draft"),
      created: now,
      updatedAt: now,
      lastBuildAt: input.lastBuildAt,
      art: input.art,
      scene: input.scene,
      history: [{ type: "created", at: now }],
    }, 0);

    return persist([project, ...(read() || [])], project, { created: true });
  }

  function updateProject(id, data) {
    const stored = read() || [];
    const index = stored.findIndex((project) => project.id === id);
    if (index === -1) return fail(ERROR_TYPES.VALIDATION, "That project could not be found.");

    const patch = data || {};
    const next = { ...stored[index] };

    if (patch.name !== undefined) next.name = safeName(patch.name);
    if (patch.prompt !== undefined) {
      next.prompt = model.safePrompt(patch.prompt);
      if (patch.description === undefined) {
        next.description = model.describeFromPrompt(next.prompt);
      }
    }
    if (patch.description !== undefined) {
      next.description = safeText(patch.description, model.MAX_DESCRIPTION);
    }
    if (patch.status !== undefined) next.status = normalizeStatus(patch.status);
    if (SCENE_ARTS.indexOf(patch.art) !== -1) next.art = patch.art;
    if (Number.isInteger(patch.scene) && patch.scene >= 0 && patch.scene < SCENE_ARTS.length) {
      next.scene = patch.scene;
    }
    // `updatedAt` may be moved by a rename; `lastBuildAt` may not be set here —
    // only recordBuild can claim a build.
    next.updatedAt = stamp(patch.updatedAt) || Date.now();

    const projects = stored.slice();
    projects[index] = next;
    return persist(projects, next);
  }

  /**
   * Record the *outcome of a finished run* for one project.
   *
   * Idempotent on runId. If this run has already been recorded — the same
   * `done` event delivered twice — the stored project is returned untouched.
   */
  function recordBuild(input) {
    const request = input || {};
    const runId = typeof request.runId === "string" ? request.runId.slice(0, 40) : "";
    const prompt = model.safePrompt(request.prompt);
    const now = stamp(request.at) || Date.now();

    const stored = read() || [];

    // 1. Duplicate protection: this run already recorded a build.
    if (runId) {
      const seen = stored.find((project) => project.runId === runId);
      if (seen) return ok({ project: { ...seen }, created: false, duplicate: true });
    }

    // 2. Identity: an explicit project id wins. Failing that, a project with
    //    the same derived name is the same project when it has never been
    //    built (an unbuilt idea is exactly what this run fulfils) or when the
    //    prompt is unchanged (the same idea built again from the composer).
    //    A different prompt under a colliding name is a different project, so
    //    an unrelated run can never overwrite someone else's finished work.
    const wantedName = request.name ? safeName(request.name) : (prompt ? BM.projectNameFromPrompt(prompt) : "");
    let index = request.projectId ? stored.findIndex((p) => p.id === request.projectId) : -1;
    if (index === -1 && wantedName) {
      index = stored.findIndex(
        (p) =>
          p.name.toLowerCase() === wantedName.toLowerCase() &&
          (!p.runId || p.prompt === prompt)
      );
    }

    if (index === -1) {
      const created = normalizeProject({
        // A real id, not the `recovered-N` placeholder normalizeProject uses
        // when a *stored* record lost its own: this record is new, so it gets
        // an id that is unique, readable in a deep link, and not tied to the
        // project's position in the array.
        id: request.projectId || newId(),
        name: wantedName || NAME_FALLBACK,
        prompt,
        description: request.description || model.describeFromPrompt(prompt),
        status: "complete",
        created: now,
        updatedAt: now,
        lastBuildAt: now,
        runId,
        history: [
          { type: "created", at: now },
          { type: "complete", at: now, ...(runId ? { runId } : {}) },
        ],
      }, stored.length);

      return persist([created, ...stored], created, { created: true, duplicate: false });
    }

    const existing = stored[index];
    const next = {
      ...existing,
      // Identity is retained: the name only changes if the record had none.
      name: existing.name || wantedName || NAME_FALLBACK,
      prompt: prompt || existing.prompt,
      description: safeText(request.description, model.MAX_DESCRIPTION)
        || model.describeFromPrompt(prompt)
        || existing.description,
      status: "complete",
      updatedAt: now,
      lastBuildAt: now,
      runId: runId || existing.runId,
      history: normalizeHistory([
        ...existing.history,
        { type: "complete", at: now, ...(runId ? { runId } : {}) },
      ]),
    };

    const projects = stored.slice();
    projects[index] = next;
    return persist(projects, next, { created: false, duplicate: false });
  }

  /**
   * Record a run that ended without producing a build. Sets the terminal
   * status, appends one history entry, and leaves `lastBuildAt` alone.
   */
  function markRun(id, outcome, runId) {
    const stored = read() || [];
    const index = stored.findIndex((project) => project.id === id);
    if (index === -1) return fail(ERROR_TYPES.VALIDATION, "That project could not be found.");

    const type = outcome === "error" ? "error" : outcome === "stopped" ? "stopped" : "";
    if (!type) return fail(ERROR_TYPES.VALIDATION, "That outcome is not recognised.");

    const existing = stored[index];
    const now = Date.now();
    const next = {
      ...existing,
      status: type,
      updatedAt: now,
      history: normalizeHistory([
        ...existing.history,
        { type, at: now, ...(runId ? { runId: String(runId).slice(0, 40) } : {}) },
      ]),
    };

    const projects = stored.slice();
    projects[index] = next;
    return persist(projects, next);
  }

  function deleteProject(id) {
    const stored = read() || [];
    const projects = stored.filter((project) => project.id !== id);
    if (projects.length === stored.length) {
      return fail(ERROR_TYPES.VALIDATION, "That project could not be found.");
    }
    write(projects);
    return ok({ id });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  BM.projectService = createService("localProjectService", {
    mode: "local",
    listProjects,
    getProject,
    createProject,
    updateProject,
    recordBuild,
    markRun,
    deleteProject,
    subscribe,
    /** Test/diagnostic hook: the lifecycle vocabulary this service accepts. */
    _statuses() {
      return { valid: VALID_STATUS.slice(), run: RUN_STATUS.slice() };
    },
    _reset() {
      storage.remove(KEY);
      listeners.clear();
      return ok(null);
    },
  });
})();
