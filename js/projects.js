/* ==========================================================================
   BuildMind — projects.js
   Project list, filtering and generated previews.

   These entries are local sample data so the layout can be reviewed.
   loadProjects() is the seam that will read real projects later.
   Each card is labelled as a sample in its meta line.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { $, $$ } = BM;

  /* ------------------------------------------------------------------------
     Sample data (local only)
     ------------------------------------------------------------------------ */
  const SAMPLE_PROJECTS = [
    {
      id: "p1",
      name: "Floating Island Survival",
      status: "ready",
      updated: "2 days ago",
      art: "lattice",
      scene: 0,
    },
    {
      id: "p2",
      name: "Checkpoint Obby",
      status: "building",
      updated: "5 hours ago",
      art: "terrain",
      scene: 1,
    },
    {
      id: "p3",
      name: "Dropper Tycoon",
      status: "ready",
      updated: "1 week ago",
      art: "graph",
      scene: 2,
    },
    {
      id: "p4",
      name: "Round-Based Arena",
      status: "draft",
      updated: "3 weeks ago",
      art: "plates",
      scene: 3,
    },
  ];

  const STATUS = {
    ready: { label: "Ready", tone: "ready" },
    building: { label: "Building", tone: "active" },
    draft: { label: "Draft", tone: "idle" },
  };

  let projects = [];
  let filter = "all";

  /* ------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------ */
  /** One card per game: name, status, last activity, open. Nothing else. */
  function projectCard(project) {
    const status = STATUS[project.status] || STATUS.draft;
    const card = document.createElement("a");
    card.className = "project-card";
    card.href = `build.html?prompt=${encodeURIComponent(project.name)}`;
    card.dataset.status = project.status;
    card.setAttribute(
      "aria-label",
      `${project.name} — ${status.label}, updated ${project.updated}`
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

  function visibleProjects() {
    if (filter === "all") return projects;
    return projects.filter((project) => project.status === filter);
  }

  function render() {
    const grid = $("#projects-grid");
    const empty = $("#projects-empty");
    const noMatch = $("#projects-no-match");
    if (!grid) return;

    grid.innerHTML = "";

    const hasProjects = projects.length > 0;
    const list = visibleProjects();

    empty.hidden = hasProjects;
    noMatch.hidden = !(hasProjects && list.length === 0);

    if (!hasProjects) {
      grid.hidden = true;
      return;
    }

    grid.hidden = false;

    if (!list.length) return;

    list.forEach((project) => grid.appendChild(projectCard(project)));
    grid.appendChild(newProjectTile());
  }

  function initFilters() {
    $$("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        filter = button.dataset.filter;
        $$("[data-filter]").forEach((b) =>
          b.setAttribute("aria-pressed", String(b === button))
        );
        render();
      });
    });
  }

  /* ------------------------------------------------------------------------
     Public seam — replace with a real fetch in a later phase.
     ------------------------------------------------------------------------ */
  function loadProjects() {
    projects = SAMPLE_PROJECTS.slice();
    render();
    return projects;
  }

  function init() {
    initFilters();
    loadProjects();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  Object.assign(BM, { loadProjects });
})();
