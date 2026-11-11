/* ==========================================================================
   BuildMind — services/projects/remoteProjectService.js
   The backend-backed implementation of the SAME contract as
   localProjectService.js.

   This is the whole point of the existing service boundary: the controllers
   and renderers do not change. They ask for `listProjects()`, they get an
   envelope, and they never learn whether the data came from localStorage or
   PostgreSQL.

   Shape translation happens here, in one place:
     remote (ISO strings, snake-derived camelCase) → the frontend project shape
     documented in localProjectService.js (epoch-ms timestamps, art/scene).

   Methods the backend cannot answer from storage alone (recordBuild,
   markRun) are implemented against the build API, not invented.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { createService, serviceOk: ok, serviceFail: fail, ERROR_TYPES } = BM;
  const model = BM.projectModel;

  /** The backend lifecycle, mapped onto the frontend's vocabulary. */
  const STATUS_MAP = {
    draft: "draft",
    ready: "ready",
    queued: "building",
    building: "building",
    testing: "testing",
    fixing: "fixing",
    validating: "validating",
    complete: "complete",
    stopped: "stopped",
    error: "error",
  };

  const SCENE_ARTS = ["lattice", "terrain", "graph", "plates", "dots", "arcs"];

  /** Deterministic art/scene per project id, so a card never flickers. */
  function pickArt(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997;
    return { art: SCENE_ARTS[hash % SCENE_ARTS.length], scene: (hash * 7) % SCENE_ARTS.length };
  }

  function toMillis(value) {
    if (!value) return 0;
    const parsed = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** remote project → frontend project */
  function toProject(remote) {
    const art = pickArt(remote.id);
    return {
      id: remote.id,
      name: remote.name || "Untitled game",
      description: remote.description || "",
      prompt: remote.prompt || "",
      status: STATUS_MAP[remote.status] || "draft",
      created: toMillis(remote.createdAt),
      updatedAt: toMillis(remote.updatedAt),
      lastBuildAt: toMillis(remote.lastBuildAt),
      runId: "",
      art: art.art,
      scene: art.scene,
      history: [],
      simulated: false,
      remote: true,
    };
  }

  /** frontend patch → remote patch (only fields the API accepts). */
  function toRemotePatch(patch) {
    const input = patch || {};
    const out = {};
    if (typeof input.name === "string") out.name = input.name.trim().slice(0, 60);
    if (typeof input.description === "string") out.description = input.description.trim().slice(0, 280);
    if (typeof input.prompt === "string") out.prompt = input.prompt.trim();
    return out;
  }

  let listeners = new Set();

  function emit(projects) {
    listeners.forEach((listener) => {
      try {
        listener(projects);
      } catch (err) {
        console.error("[BuildMind] project listener failed", err);
      }
    });
  }

  const implementation = {
    mode: "remote",

    listProjects() {
      return BM.api.listProjects({ limit: 100 }).then((result) => {
        if (!BM.isOk(result)) return result;
        const projects = (result.data.projects || []).map(toProject);
        emit(projects);
        return ok({ projects });
      });
    },

    getProject(id) {
      return BM.api.getProject(id).then((result) => {
        if (!BM.isOk(result)) return result;
        return ok({ project: toProject(result.data.project) });
      });
    },

    createProject(data) {
      const input = data || {};
      return BM.api
        .createProject({
          name: String(input.name || "Untitled game").slice(0, 60),
          description: String(input.description || "").slice(0, 280),
          ...(input.prompt ? { prompt: String(input.prompt) } : {}),
        })
        .then((result) => {
          if (!BM.isOk(result)) return result;
          return ok({ project: toProject(result.data.project) });
        });
    },

    updateProject(id, patch) {
      const remotePatch = toRemotePatch(patch);
      if (Object.keys(remotePatch).length === 0) {
        return Promise.resolve(fail(ERROR_TYPES.VALIDATION, "Nothing to update."));
      }
      return BM.api.updateProject(id, remotePatch).then((result) => {
        if (!BM.isOk(result)) return result;
        return ok({ project: toProject(result.data.project) });
      });
    },

    deleteProject(id) {
      return BM.api.deleteProject(id).then((result) => {
        if (!BM.isOk(result)) return result;
        return ok({ id });
      });
    },

    /**
     * Record a completed build against its project.
     *
     * On the remote path the backend already owns this relationship: a build
     * row carries its project id. So this is a refresh, not a write — calling
     * it must not create a second project, which is exactly the bug the local
     * service's `recordBuild` guards against.
     */
    recordBuild(input) {
      const projectId = input && input.projectId;
      if (!projectId) return Promise.resolve(fail(ERROR_TYPES.VALIDATION, "No project to record."));

      return BM.api.getProject(projectId).then((result) => {
        if (!BM.isOk(result)) return result;
        return ok({ project: toProject(result.data.project), created: false, duplicate: false });
      });
    },

    /** A stopped or failed run is recorded by the backend, not here. */
    markRun(id) {
      return BM.api.getProject(id).then((result) => {
        if (!BM.isOk(result)) return result;
        return ok({ project: toProject(result.data.project) });
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Test seam: forget listeners between runs. */
    _reset() {
      listeners = new Set();
    },
  };

  BM.remoteProjectService = createService("projects", implementation);
  BM.toRemoteProject = toProject;
})();
