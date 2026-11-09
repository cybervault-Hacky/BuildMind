/* ==========================================================================
   BuildMind — services/projects/localProjectService.js
   The project boundary. Today projects live in localStorage; a future
   `remoteProjectService` implements the same six methods against a backend
   and the renderers do not change.

   Public surface (contracts.js envelopes, never throws):

     listProjects()        → { projects }
     getProject(id)        → { project }
     createProject(data)   → { project }
     updateProject(id,data)→ { project }
     deleteProject(id)     → { id }
     subscribe(listener)   → unsubscribe

   Shape of a project:
     { id, name, status, updated, art, scene, simulated? }

   `status` is one of ready | building | complete | draft.
   Projects are local mock data. Nothing here publishes, uploads or syncs.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES, storage, STORAGE_KEYS } = BM;

  const KEY = STORAGE_KEYS.projects;
  const MAX_NAME = 60;
  const NAME_FALLBACK = "Untitled game";
  const VALID_STATUS = ["ready", "building", "complete", "draft"];
  const SCENE_ARTS = ["lattice", "terrain", "graph", "plates", "dots", "arcs"];

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
     Input safety — names are user-controlled strings. They are stored as
     plain text and only ever written to the DOM through textContent, so they
     are never interpreted as HTML. Trimming and length-capping here keeps the
     stored data predictable.
     ------------------------------------------------------------------------ */
  function safeName(value) {
    const text = String(value === undefined || value === null ? "" : value)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME);
    return text || NAME_FALLBACK;
  }

  function normalizeStatus(value) {
    return VALID_STATUS.indexOf(value) === -1 ? "draft" : value;
  }

  function artForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    return { art: SCENE_ARTS[hash % SCENE_ARTS.length], scene: hash % 6 };
  }

  function newId() {
    return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function isValid(project) {
    return Boolean(
      project &&
        typeof project.id === "string" &&
        project.id &&
        typeof project.name === "string" &&
        typeof project.status === "string" &&
        VALID_STATUS.indexOf(project.status) !== -1
    );
  }

  /** Read → validate → drop anything malformed. Corrupt storage yields []. */
  function read() {
    const stored = storage.readArray(KEY);
    if (stored === null) return null;
    return stored.filter(isValid).map((project) => ({ ...project }));
  }

  function write(projects) {
    storage.write(KEY, projects);
    emit(projects);
  }

  /* ------------------------------------------------------------------------
     Sample data — only for a brand-new visitor. Once a list has been written
     (even an empty one) it is respected as the user's real list.
     ------------------------------------------------------------------------ */
  function samples() {
    return [
      { id: "sample-island", name: "Floating Island Survival", status: "ready", updated: "2 days ago", art: "lattice", scene: 0, sample: true },
      { id: "sample-obby", name: "Checkpoint Obby", status: "building", updated: "5 hours ago", art: "terrain", scene: 1, sample: true },
      { id: "sample-tycoon", name: "Dropper Tycoon", status: "ready", updated: "1 week ago", art: "graph", scene: 2, sample: true },
      { id: "sample-arena", name: "Round-Based Arena", status: "draft", updated: "3 weeks ago", art: "plates", scene: 3, sample: true },
    ];
  }

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

  function createProject(data) {
    const input = data || {};
    const name = safeName(input.name);

    if (!name) return fail(ERROR_TYPES.VALIDATION, "Give the project a name.");

    const art = artForName(name);
    const project = {
      id: input.id || newId(),
      name,
      status: normalizeStatus(input.status || "draft"),
      updated: safeName(input.updated || "Just now"),
      art: SCENE_ARTS.indexOf(input.art) === -1 ? art.art : input.art,
      scene: Number.isInteger(input.scene) ? input.scene : art.scene,
      simulated: true,
    };

    const stored = read() || [];
    write([project, ...stored]);
    return ok({ project: { ...project } });
  }

  function updateProject(id, data) {
    const stored = read() || [];
    const index = stored.findIndex((project) => project.id === id);
    if (index === -1) return fail(ERROR_TYPES.VALIDATION, "That project could not be found.");

    const patch = data || {};
    const next = { ...stored[index] };

    if (patch.name !== undefined) next.name = safeName(patch.name);
    if (patch.status !== undefined) next.status = normalizeStatus(patch.status);
    if (patch.updated !== undefined) next.updated = safeName(patch.updated);
    if (SCENE_ARTS.indexOf(patch.art) !== -1) next.art = patch.art;
    if (Number.isInteger(patch.scene)) next.scene = patch.scene;

    const projects = stored.slice();
    projects[index] = next;
    write(projects);
    return ok({ project: { ...next } });
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
    deleteProject,
    subscribe,
    _reset() {
      storage.remove(KEY);
      listeners.clear();
      return ok(null);
    },
  });
})();
