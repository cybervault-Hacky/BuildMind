/* ==========================================================================
   BuildMind — controllers/projectController.js
   The only writer of the project slice.

   Renderers never build a project object and never edit the array. They ask
   this controller; the controller asks projectService; the result is written
   into the central store; subscribers repaint.

     UI → projectController → projectService → state → renderer

   A completed simulated build is recorded here too, through the same
   `createProject` / `updateProject` calls a manual create would use.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { ERROR_TYPES } = BM;

  function service() {
    return BM.projectService;
  }

  /** Load the list into state. Safe to call on every page. */
  function load() {
    return service().listProjects().then((result) => {
      if (!BM.isOk(result)) return result;
      BM.setProjects(result.data.projects);
      return result;
    });
  }

  function refresh() {
    return load();
  }

  function get(id) {
    return service().getProject(id);
  }

  function create(data) {
    return service().createProject(data).then((result) => {
      if (!BM.isOk(result)) return result;
      BM.insertProject(result.data.project);
      return result;
    });
  }

  function update(id, patch) {
    return service().updateProject(id, patch).then((result) => {
      if (!BM.isOk(result)) return result;
      BM.replaceProject(result.data.project);
      return result;
    });
  }

  function remove(id) {
    return service().deleteProject(id).then((result) => {
      if (!BM.isOk(result)) return result;
      BM.removeProject(id);
      return result;
    });
  }

  /**
   * Record a finished simulated build.
   * The same derived name updates an existing project instead of duplicating it.
   */
  function recordBuild(prompt) {
    const name = BM.projectNameFromPrompt(prompt);
    const existing = BM.getState().projects.find((project) => project.name === name);

    if (existing) {
      return update(existing.id, { status: "complete", updated: "Just now" });
    }

    return create({ name, status: "complete", updated: "Just now" });
  }

  /** Filters are derived from the data — never stored separately. */
  function filters() {
    return BM.projectFilters();
  }

  function setFilter(filter) {
    BM.setProjectFilter(filter);
    return BM.serviceOk({ filter });
  }

  function list(filter) {
    const projects = BM.getState().projects;
    if (!filter || filter === "all") return projects.slice();
    return projects.filter((project) => project.status === filter);
  }

  BM.projectController = {
    mode: "local",
    load,
    refresh,
    get,
    create,
    update,
    remove,
    recordBuild,
    filters,
    setFilter,
    list,
    failExample() {
      return BM.serviceFail(ERROR_TYPES.OPERATION, "Projects are unavailable right now.");
    },
  };
})();
