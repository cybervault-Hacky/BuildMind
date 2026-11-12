/* ==========================================================================
   BuildMind — controllers/projectController.js
   The only writer of the project slice.

   Renderers never build a project object and never edit the array. They ask
   this controller; the controller asks projectService; the result is written
   into the central store; subscribers repaint.

     UI → projectController → projectService → state → renderer

   Responsibilities kept here (and nowhere else):

     • Which project Build is working on (`open`, `close`) — a UI fact, not a
       stored field, so a reload never claims a stale "active" project.
     • Build identity — `recordBuild` passes the active project id and the run
       id together, so a rebuild updates one project instead of creating one.
     • Terminal outcomes — a stopped or failed run is recorded as an event on
       the project it belonged to, and never as a build.
     • Filter and search state, both derived on read.
     • The list's request lifecycle, so the page can show a loading state and
       an honest error instead of an empty list that means nothing.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES } = BM;

  function service() {
    return BM.projectService;
  }

  function model() {
    return BM.projectModel;
  }

  /* ------------------------------------------------------------------------
     Reads
     ------------------------------------------------------------------------ */
  /** Load the list into state. Safe to call on every page. */
  function load(options) {
    BM.setProjectsStatus("loading", null);

    return service()
      .listProjects({}, options)
      .then((result) => {
        if (!BM.isOk(result)) {
          BM.setProjectsStatus("error", result.error ? result.error.message : "Projects could not be loaded.");
          return result;
        }
        BM.setProjects(result.data.projects);
        BM.setProjectsStatus("ready", null);
        return result;
      });
  }

  function refresh(options) {
    return load(options);
  }

  function get(id, options) {
    return service().getProject(id, options);
  }

  /** All projects, newest build first (the store keeps them sorted). */
  function all() {
    return BM.getState().projects.slice();
  }

  function active() {
    return BM.getActiveProject();
  }

  function filters() {
    return BM.projectFilters();
  }

  /** The visible list for a filter + query pair. Never mutates project data. */
  function visible(filter, query) {
    const status = filter === undefined || filter === null ? BM.getState().projectsFilter : filter;
    const text = query === undefined || query === null ? BM.getState().projectsQuery : query;

    return all().filter((project) => {
      if (status && status !== "all" && project.status !== status) return false;
      return model().matchesQuery(project, text);
    });
  }

  function count() {
    return BM.getState().projects.length;
  }

  /* ------------------------------------------------------------------------
     Writes
     ------------------------------------------------------------------------ */
  function create(data, options) {
    return service()
      .createProject(data, options)
      .then((result) => {
        if (!BM.isOk(result)) return result;
        BM.insertProject(result.data.project);
        return result;
      });
  }

  function update(id, patch, options) {
    return service()
      .updateProject(id, patch, options)
      .then((result) => {
        if (!BM.isOk(result)) return result;
        BM.replaceProject(result.data.project);
        return result;
      });
  }

  function remove(id, options) {
    return service()
      .deleteProject(id, options)
      .then((result) => {
        if (!BM.isOk(result)) return result;
        BM.removeProject(id);
        return result;
      });
  }

  /**
   * Open a project in the Build workspace: it becomes the active project and
   * its prompt comes back as the editable composer text. Never returns or
   * restores a key — the composer only ever sees the prompt and the settings
   * the user already chose.
   */
  function open(id, options) {
    if (!id) {
      return Promise.resolve(BM.serviceFail(ERROR_TYPES.VALIDATION, "That project could not be found."));
    }

    return service()
      .getProject(id, options)
      .then((result) => {
        if (!BM.isOk(result)) return result;
        const project = result.data.project;
        BM.insertProject(project);
        BM.setActiveProject(project.id);
        return BM.serviceOk({ project: { ...project } });
      });
  }

  /** Clear the active project (Build is no longer working on a project). */
  function close() {
    BM.setActiveProject("");
    return BM.serviceOk(null);
  }

  /**
   * Record a finished build.
   *
   * `input` is either the prompt string (older callers) or
   * `{ prompt, runId, projectId, name }`. Identity, in order:
   *   1. the active project id — a rebuild updates that project
   *   2. an explicit projectId
   *   3. the derived name, for a first build with nothing open
   * and duplicate protection on `runId` lives in the service.
   */
  function recordBuild(input, options) {
    const request = typeof input === "string" ? { prompt: input } : (input || {});
    const payload = {
      ...request,
      projectId: request.projectId || BM.getState().activeProjectId || "",
    };

    return service()
      .recordBuild(payload, options)
      .then((result) => {
        if (!BM.isOk(result)) return result;
        BM.replaceProject(result.data.project);
        // The build that produced this project is now the active one, so the
        // next "Build again" keeps updating the same record.
        BM.setActiveProject(result.data.project.id);
        return result;
      });
  }

  /**
   * A run ended without a build. Only the project it belonged to is touched,
   * and only its event history and status — never its last-build time.
   */
  function markRun(outcome, runId, options) {
    const id = BM.getState().activeProjectId;
    if (!id) return Promise.resolve(BM.serviceOk(null));

    return service()
      .markRun(id, outcome, runId, options)
      .then((result) => {
        if (!BM.isOk(result)) return result;
        BM.replaceProject(result.data.project);
        return result;
      });
  }

  /* ------------------------------------------------------------------------
     Filter / search
     ------------------------------------------------------------------------ */
  function setFilter(filter) {
    BM.setProjectFilter(filter);
    return BM.serviceOk({ filter });
  }

  function setQuery(query) {
    BM.setProjectQuery(query);
    return BM.serviceOk({ query });
  }

  /** Kept for older callers: list(filter) == visible(filter, current query). */
  function list(filter) {
    return visible(filter);
  }

  BM.projectController = {
    mode: "remote",
    load,
    refresh,
    get,
    all,
    active,
    open,
    close,
    count,
    create,
    update,
    remove,
    recordBuild,
    markRun,
    filters,
    visible,
    setFilter,
    setQuery,
    list,
    failExample() {
      return BM.serviceFail(ERROR_TYPES.OPERATION, "Projects are unavailable right now.");
    },
  };
})();
