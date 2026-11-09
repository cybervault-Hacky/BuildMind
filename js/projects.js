/* ==========================================================================
   BuildMind — projects.js
   A renderer over the project slice of js/state.js.

   Cards, filters and empty states are all painted from state, so filtering
   never mutates the data and a completed simulated build appears here without
   a reload. Projects are local mock data; no real game exists.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { $, PROJECT_STATUS, getState, subscribe, loadProjects, setProjectFilter, projectFilters } = BM;

  const el = {};

  function cache() {
    el.grid = $("#projects-grid");
    el.empty = $("#projects-empty");
    el.noMatch = $("#projects-no-match");
    el.filters = $("#project-filters");
    el.count = $("#projects-count");
    el.live = $("#projects-live");
  }

  /* ------------------------------------------------------------------------
     Markup
     ------------------------------------------------------------------------ */
  function projectCard(project) {
    const status = PROJECT_STATUS[project.status] || PROJECT_STATUS.draft;
    const card = document.createElement("a");
    card.className = "project-card";
    card.href = `build.html?prompt=${encodeURIComponent(project.name)}`;
    card.dataset.status = project.status;
    card.dataset.id = project.id;
    card.setAttribute(
      "aria-label",
      `${project.name} — ${status.label}, updated ${project.updated}. Open in Build.`
    );

    card.innerHTML = `
      <span class="project-card__thumb">
        <span class="project-card__art art-${project.art} scene-${project.scene}" aria-hidden="true"></span>
      </span>
      <span class="project-card__body">
        <span class="project-card__name"></span>
        <span class="project-card__meta">
          <span class="status status--${status.tone}">
            <span class="status__dot" aria-hidden="true"></span>
            <span class="status__text">${status.label}</span>
          </span>
          <span class="sep" aria-hidden="true"></span>
          <span class="js-updated"></span>
        </span>
        <span class="project-card__open" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.2 8h9.6M9 4.2 12.8 8 9 11.8"/>
          </svg>
        </span>
      </span>`;

    card.querySelector(".project-card__name").textContent = project.name;
    card.querySelector(".js-updated").textContent = project.updated;
    return card;
  }

  function newProjectTile() {
    const tile = document.createElement("a");
    tile.className = "project-new";
    tile.href = "build.html";
    tile.innerHTML = `
      <span class="project-new__plus" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
      </span>
      <span class="project-new__label">New project</span>`;
    return tile;
  }

  /* ------------------------------------------------------------------------
     Render
     ------------------------------------------------------------------------ */
  function renderFilters(view) {
    if (!el.filters) return;

    const filters = projectFilters();
    // A filter that no longer has any matches falls back to "All".
    const active = filters.some((f) => f.id === view.projectsFilter) ? view.projectsFilter : "all";

    el.filters.innerHTML = filters
      .map(
        (filter) => `
        <button class="segmented__option" type="button" data-filter="${filter.id}"
                aria-pressed="${filter.id === active}">${filter.label}</button>`
      )
      .join("");
  }

  function render() {
    const view = getState();
    if (!el.grid) return;

    const filters = projectFilters();
    const active = filters.some((f) => f.id === view.projectsFilter) ? view.projectsFilter : "all";

    renderFilters(view);

    const list = active === "all"
      ? view.projects
      : view.projects.filter((project) => project.status === active);

    el.grid.innerHTML = "";

    const hasProjects = view.projects.length > 0;
    const hasMatches = list.length > 0;

    if (el.empty) el.empty.hidden = hasProjects;
    if (el.noMatch) el.noMatch.hidden = !(hasProjects && !hasMatches);
    el.grid.hidden = !hasProjects || !hasMatches;

    if (el.count) {
      el.count.textContent = hasProjects
        ? `${view.projects.length} ${view.projects.length === 1 ? "project" : "projects"}`
        : "";
    }

    if (!hasProjects || !hasMatches) return;

    list.forEach((project) => el.grid.appendChild(projectCard(project)));
    el.grid.appendChild(newProjectTile());
  }

  function announce(message) {
    if (!el.live) return;
    el.live.textContent = "";
    requestAnimationFrame(() => {
      el.live.textContent = message;
    });
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  function bindEvents() {
    // Delegated: the filter buttons are re-rendered from state.
    $("#projects-reset-filter")?.addEventListener("click", () => {
      setProjectFilter("all");
      announce("Showing all projects");
    });

    el.filters?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;

      setProjectFilter(button.dataset.filter);
      const label = button.textContent.trim();
      announce(label === "All" ? "Showing all projects" : `Showing ${label.toLowerCase()} projects`);
    });
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    cache();
    bindEvents();

    // A stored list is already in state; loadProjects() is the seam that will
    // fetch real projects later.
    if (!getState().projects.length) loadProjects();

    subscribe((view, changed) => {
      if (!changed.length || changed.includes("projects") || changed.includes("projectsFilter")) {
        render();
      }
    });

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
