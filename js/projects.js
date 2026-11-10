/* ==========================================================================
   BuildMind — projects.js
   A renderer over the project slice of js/state.js.

   This file never builds a project object, never edits the array and never
   touches storage. Reads come from state; every intent — open, delete, filter,
   search — goes to the project controller. Persistence, validation and the
   duplicate-run rule belong to projectService.

   Rendering is keyed by project id. A card node is created once and then only
   its changed text/classes are written, so:

     • typing in the search field repaints nothing but the list,
     • changing a filter never recreates a card that is still visible,
     • a project's timer or status coming back from storage updates in place.

   Projects are local mock data; no real game exists and nothing is published.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const { $, getState, subscribe, toast } = BM;

  const controller = () => BM.projectController;
  const model = () => BM.projectModel;

  const el = {};
  /** id → { node, refs } for every card currently mounted. */
  const mounted = new Map();
  /** id → { node, refs, timer } for cards fading out, so a quick re-show
      reuses the same node instead of stacking a duplicate. */
  const leaving = new Map();
  let lastOrder = [];
  let pendingDelete = "";
  /** The element focus should return to when the dialog closes. */
  let dialogReturnFocus = null;

  /* Static card chrome. Never contains a user-controlled value: names,
     descriptions and times are written with textContent below. */
  const CARD_HTML = `
    <div class="project-card__thumb">
      <span class="project-card__art" aria-hidden="true">
        <span class="art-planes"></span>
      </span>
      <span class="project-card__flag" data-flag hidden>In Build</span>
    </div>
    <div class="project-card__body">
      <div class="project-card__head">
        <h3 class="project-card__name"></h3>
        <span class="status">
          <span class="status__dot" aria-hidden="true"></span>
          <span class="status__text"></span>
        </span>
      </div>
      <p class="project-card__desc"></p>
      <div class="project-card__foot">
        <span class="project-card__build" data-build></span>
        <div class="project-card__actions">
          <a class="btn btn--ghost btn--sm project-card__open">
            <span>Open</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.2 8h9.6M9 4.2 12.8 8 9 11.8"/>
            </svg>
          </a>
          <button class="icon-btn project-card__delete" type="button">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.2 5.2h9.6M6.4 5.2V3.6h3.2v1.6M4.6 5.2l.6 7.2h5.6l.6-7.2M6.8 7.4v3.2M9.2 7.4v3.2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>`;

  function cache() {
    el.grid = $("#projects-grid");
    el.empty = $("#projects-empty");
    el.noMatch = $("#projects-no-match");
    el.noResults = $("#projects-no-results");
    el.noResultsTitle = $("#projects-no-results-title");
    el.noMatchTitle = $("#projects-no-match-title");
    el.noMatchNote = $("#projects-no-match-note");
    el.noMatchClearSearch = $("#projects-no-match-clear");
    el.filters = $("#project-filters");
    el.toolbar = $("#project-toolbar");
    el.count = $("#projects-count");
    el.live = $("#projects-live");
    el.search = $("#projects-search");
    el.searchClear = $("#projects-search-clear");
    el.resetFilter = $("#projects-reset-filter");
    el.resetSearch = $("#projects-reset-search");
    el.dialog = $("#project-delete-dialog");
    el.dialogName = $("#project-delete-name");
    el.dialogConfirm = $("#project-delete-confirm");
    el.dialogCancel = $("#project-delete-cancel");
  }

  /* ------------------------------------------------------------------------
     Card nodes — created once, updated in place
     ------------------------------------------------------------------------ */
  /**
   * A card that is still fading out is reused rather than rebuilt, so a fast
   * filter change back and forth never stacks a duplicate node or replays the
   * entrance animation.
   */
  function reviveCard(id) {
    const pending = leaving.get(id);
    if (!pending) return null;

    leaving.delete(id);
    window.clearTimeout(pending.timer);
    pending.node.classList.remove("is-entering", "is-leaving");
    pending.refs.shown = {};
    mounted.set(id, pending);
    return pending;
  }

  function buildCard(project) {
    const node = document.createElement("article");
    node.className = "project-card is-entering";
    node.innerHTML = CARD_HTML;

    const refs = {
      name: node.querySelector(".project-card__name"),
      status: node.querySelector(".status"),
      statusText: node.querySelector(".status__text"),
      desc: node.querySelector(".project-card__desc"),
      build: node.querySelector("[data-build]"),
      open: node.querySelector(".project-card__open"),
      del: node.querySelector(".project-card__delete"),
      art: node.querySelector(".project-card__art"),
      flag: node.querySelector("[data-flag]"),
      shown: {},
    };

    refs.del.addEventListener("click", () => askDelete(project.id, refs.del));
    refs.open.addEventListener("click", () => {
      // The link navigates; this only marks the intent for the live region.
      announce(`Opening ${project.name}`);
    });

    mounted.set(project.id, { node, refs });
    // The entrance animation is CSS; the flag only exists so a reused node
    // never replays it.
    window.setTimeout(() => node.classList.remove("is-entering"), 420);
    return { node, refs };
  }

  /** Write only what changed. A no-op update costs a few comparisons. */
  function updateCard(entry, project, activeId) {
    const { node, refs } = entry;
    const meta = model().statusMeta(project.status);
    const now = Date.now();

    if (node.dataset.id !== project.id) node.dataset.id = project.id;
    if (node.dataset.status !== project.status) node.dataset.status = project.status;

    const artClass = `project-card__art art-${project.art} scene-${project.scene}`;
    if (refs.art.className !== artClass) refs.art.className = artClass;

    // Name — user string, textContent only.
    if (refs.shown.name !== project.name) {
      refs.name.textContent = project.name;
      refs.shown.name = project.name;
    }

    const statusClass = `status status--${meta.tone}`;
    const statusChanged = refs.shown.status !== undefined && refs.shown.status !== meta.label;
    if (!refs.status.classList.contains("status") || refs.shown.statusTone !== meta.tone) {
      refs.status.className = statusClass;
      refs.shown.statusTone = meta.tone;
    }
    if (refs.shown.status !== meta.label) {
      refs.statusText.textContent = meta.label;
      refs.shown.status = meta.label;
    }
    // A state change is worth one calm tint — never a flash, never a loop.
    if (statusChanged) {
      refs.status.classList.add("is-changing");
      window.setTimeout(() => refs.status.classList.remove("is-changing"), 340);
    }

    const description = project.description || "No description yet.";
    if (refs.shown.desc !== description) {
      refs.desc.textContent = description;
      refs.shown.desc = description;
    }

    const buildLabel = model().lastBuildLabel(project, now);
    if (refs.shown.build !== buildLabel) {
      refs.build.textContent = buildLabel;
      refs.shown.build = buildLabel;
    }
    node.classList.toggle("is-unbuilt", !model().isBuilt(project));

    // Action → the project opens in Build; the href carries the id, never the
    // name, so the workspace restores the real prompt.
    const href = `build.html?project=${encodeURIComponent(project.id)}`;
    if (refs.open.getAttribute("href") !== href) refs.open.setAttribute("href", href);
    const openLabel = `Open ${project.name} in Build`;
    if (refs.open.getAttribute("aria-label") !== openLabel) refs.open.setAttribute("aria-label", openLabel);

    const delLabel = `Delete ${project.name}`;
    if (refs.del.getAttribute("aria-label") !== delLabel) refs.del.setAttribute("aria-label", delLabel);

    const isActive = project.id === activeId;
    node.classList.toggle("is-active", isActive);
    if (refs.flag.hidden === isActive) refs.flag.hidden = !isActive;

    if (refs.shown.stack !== statusClass + description + buildLabel) {
      refs.shown.stack = statusClass + description + buildLabel;
    }
  }

  function removeCard(id, immediate) {
    const entry = mounted.get(id);
    if (!entry) return;
    mounted.delete(id);

    if (immediate) {
      entry.node.remove();
      return;
    }

    entry.node.classList.add("is-leaving");
    const timer = window.setTimeout(() => {
      leaving.delete(id);
      entry.node.remove();
    }, 220);
    leaving.set(id, { ...entry, timer });
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
     Filters
     ------------------------------------------------------------------------ */
  function renderFilters(view) {
    if (!el.filters) return;

    const filters = controller().filters();
    const active = filters.some((f) => f.id === view.projectsFilter) ? view.projectsFilter : "all";
    const signature = filters.map((f) => `${f.id}:${f.label}`).join("|") + `#${active}`;

    if (el.filters.dataset.signature === signature) return;
    el.filters.dataset.signature = signature;

    const existing = new Map();
    Array.from(el.filters.querySelectorAll("[data-filter]")).forEach((button) => {
      existing.set(button.dataset.filter, button);
    });

    filters.forEach((filter) => {
      let button = existing.get(filter.id);
      if (!button) {
        button = document.createElement("button");
        button.className = "segmented__option";
        button.type = "button";
        button.dataset.filter = filter.id;
        el.filters.appendChild(button);
      } else {
        existing.delete(filter.id);
        el.filters.appendChild(button); // keeps DOM order in step with the data
      }
      if (button.textContent !== filter.label) button.textContent = filter.label;
      button.setAttribute("aria-pressed", String(filter.id === active));
    });

    existing.forEach((button) => button.remove());
  }

  /* ------------------------------------------------------------------------
     Render
     ------------------------------------------------------------------------ */
  function render() {
    const view = getState();
    if (!el.grid) return;

    const filters = controller().filters();
    const activeFilter = filters.some((f) => f.id === view.projectsFilter) ? view.projectsFilter : "all";
    const query = view.projectsQuery || "";
    const list = controller().visible(activeFilter, query);

    const hasProjects = view.projects.length > 0;
    const hasMatches = list.length > 0;

    renderFilters(view);
    renderSearch(query, hasProjects);

    // Cards: revive, mount, update, reorder, retire.
    const wanted = hasProjects ? list.map((project) => project.id) : [];

    // Revival has to happen before the retire pass: a card still fading out
    // that is coming back keeps its node instead of stacking a duplicate.
    wanted.forEach((id) => {
      if (!mounted.has(id)) reviveCard(id);
    });

    mounted.forEach((entry, id) => {
      if (wanted.indexOf(id) === -1) removeCard(id, !hasProjects);
    });

    wanted.forEach((id, index) => {
      const project = list[index];
      let entry = mounted.get(id);
      if (!entry) entry = buildCard(project);
      updateCard(entry, project, view.activeProjectId);
    });

    // Reorder only when the visible order actually changed.
    const orderKey = wanted.join(",");
    if (orderKey !== lastOrder.join(",")) {
      wanted.forEach((id) => {
        const entry = mounted.get(id);
        if (entry) el.grid.appendChild(entry.node);
      });
      lastOrder = wanted;
    }

    if (hasProjects && hasMatches && !el.grid.querySelector(".project-new")) {
      el.grid.appendChild(newProjectTile());
    }
    if (!hasProjects || !hasMatches) {
      const tile = el.grid.querySelector(".project-new");
      if (tile) tile.remove();
    }

    el.grid.hidden = !hasProjects || !hasMatches;

    const noMatches = hasProjects && !hasMatches;
    const filterActive = activeFilter !== "all";

    if (el.toolbar) el.toolbar.hidden = !hasProjects;
    if (el.empty) el.empty.hidden = hasProjects;

    // A filter with no matches and a search with no matches are different
    // dead ends with different ways out, so they never share a panel.
    if (el.noMatch) {
      el.noMatch.hidden = !(noMatches && filterActive);
      if (el.noMatchTitle) {
        el.noMatchTitle.textContent = query
          ? `No projects match “${query}” in ${activeFilterLabel(filters, activeFilter)}`
          : "No projects in this filter";
      }
      if (el.noMatchNote) {
        el.noMatchNote.textContent = query
          ? "Try clearing the search, or show everything."
          : "Nothing has that state right now.";
      }
      if (el.noMatchClearSearch) el.noMatchClearSearch.hidden = !query;
    }

    if (el.noResults) {
      el.noResults.hidden = !(noMatches && !filterActive);
      if (el.noResultsTitle) el.noResultsTitle.textContent = `No projects match “${query}”`;
    }

    if (el.count) {
      const caption = hasProjects
        ? `${view.projects.length} ${view.projects.length === 1 ? "project" : "projects"}`
        : "";
      // Assigning the same string still replaces the text node, so a keystroke
      // would repaint the heading for nothing.
      if (el.count.textContent !== caption) el.count.textContent = caption;
    }
  }

  function activeFilterLabel(filters, id) {
    const found = filters.find((filter) => filter.id === id);
    if (!found) return "this filter";
    return found.label.toLowerCase() === "all" ? "all projects" : `“${found.label}”`;
  }

  function renderSearch(query, hasProjects) {
    if (!el.search) return;
    if (el.search.value !== query && document.activeElement !== el.search) {
      el.search.value = query;
    }
    if (el.searchClear) el.searchClear.hidden = !query;
    el.search.disabled = !hasProjects;
  }

  function announce(message) {
    if (!el.live) return;
    el.live.textContent = "";
    window.setTimeout(() => {
      el.live.textContent = message;
    }, 30);
  }

  /* ------------------------------------------------------------------------
     Delete — one modal, native <dialog> where available
     ------------------------------------------------------------------------ */
  function supportsDialog() {
    return el.dialog && typeof el.dialog.showModal === "function";
  }

  function openDialog() {
    if (!el.dialog) return;
    if (supportsDialog()) {
      el.dialog.showModal();
      return;
    }
    // Fallback for environments without showModal: still a real modal to
    // assistive tech, with Escape handled below.
    el.dialog.setAttribute("open", "");
    el.dialog.setAttribute("role", "dialog");
    el.dialog.setAttribute("aria-modal", "true");
    el.dialogConfirm?.focus();
  }

  function isDialogOpen() {
    if (!el.dialog) return false;
    return supportsDialog() ? el.dialog.open === true : el.dialog.hasAttribute("open");
  }

  function closeDialog() {
    if (!el.dialog) return;
    if (supportsDialog()) {
      el.dialog.close();
      return;
    }
    el.dialog.removeAttribute("open");
  }

  function askDelete(id, trigger) {
    const project = getState().projects.find((item) => item.id === id);
    if (!project) return;

    pendingDelete = id;
    dialogReturnFocus = trigger || null;
    if (el.dialogName) el.dialogName.textContent = project.name;
    if (el.dialogConfirm) el.dialogConfirm.focus();
    openDialog();
  }

  function confirmDelete() {
    const id = pendingDelete;
    const project = getState().projects.find((item) => item.id === id);
    pendingDelete = "";

    if (!id) return;

    // Focus has to land somewhere sensible before the node is removed.
    const order = controller().visible();
    const index = order.findIndex((item) => item.id === id);
    const next = order[index + 1] || order[index - 1] || null;

    controller().remove(id).then((result) => {
      if (!BM.isOk(result)) {
        toast(result.error.message);
        return;
      }

      announce(`${project ? project.name : "Project"} deleted`);
      const neighbour = next ? mounted.get(next.id) : null;
      if (neighbour) {
        neighbour.refs.open.focus();
      } else if (el.empty && !el.empty.hidden && el.empty.querySelector(".btn")) {
        el.empty.querySelector(".btn").focus();
      } else if (el.search && !el.search.disabled) {
        el.search.focus();
      }
      dialogReturnFocus = null;
    });
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */
  function bindEvents() {
    el.filters?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;

      controller().setFilter(button.dataset.filter);
      const label = button.textContent.trim();
      const count = controller().visible(button.dataset.filter).length;
      announce(
        label === "All"
          ? `Showing all ${count} ${count === 1 ? "project" : "projects"}`
          : `${label}: ${count} ${count === 1 ? "project" : "projects"}`
      );
    });

    // Keyboard support comes free with native buttons; Arrow keys move
    // between filters, matching the segmented control pattern.
    el.filters?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const buttons = Array.from(el.filters.querySelectorAll("[data-filter]"));
      const index = buttons.indexOf(document.activeElement);
      if (index === -1) return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length].focus();
    });

    el.search?.addEventListener("input", () => {
      controller().setQuery(el.search.value);
    });

    el.search?.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.search.value) {
        event.preventDefault();
        el.search.value = "";
        controller().setQuery("");
        el.search.focus();
        announce("Search cleared");
      }
    });

    el.searchClear?.addEventListener("click", () => {
      if (el.search) {
        el.search.value = "";
        el.search.focus();
      }
      controller().setQuery("");
      announce("Search cleared");
    });

    el.resetFilter?.addEventListener("click", () => {
      controller().setFilter("all");
      announce("Showing all projects");
    });

    el.noMatchClearSearch?.addEventListener("click", () => {
      if (el.search) {
        el.search.value = "";
        el.search.focus();
      }
      controller().setQuery("");
      announce("Search cleared");
    });

    el.resetSearch?.addEventListener("click", () => {
      if (el.search) {
        el.search.value = "";
        el.search.focus();
      }
      controller().setQuery("");
      announce("Search cleared");
    });

    // Escape closes the dialog without deleting. Both the native and the
    // fallback path fire `cancel`/`keydown`, so one handler covers each.
    el.dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
      cancelDelete();
    });

    // Attached to the document, in the capture phase, because the dialog only
    // receives key events while focus is inside it.
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        if (!el.dialog || !isDialogOpen()) return;
        event.preventDefault();
        closeDialog();
        cancelDelete();
      },
      true
    );

    el.dialogCancel?.addEventListener("click", () => {
      closeDialog();
      cancelDelete();
    });

    el.dialogConfirm?.addEventListener("click", () => {
      closeDialog();
      confirmDelete();
    });

    // Native `close` fires for every path; it only clears the fallback roles.
    el.dialog?.addEventListener("close", () => {
      el.dialog.removeAttribute("role");
      el.dialog.removeAttribute("aria-modal");
    });
  }

  function cancelDelete() {
    pendingDelete = "";
    if (dialogReturnFocus && document.contains(dialogReturnFocus)) dialogReturnFocus.focus();
    dialogReturnFocus = null;
  }

  /**
   * ?project=<id> marks the project Build just finished, so arriving here from
   * the result panel lands on the record instead of a list that looks the same
   * as every other. It also scrolls that card into view.
   */
  function highlightDeepLink() {
    const id = new URLSearchParams(window.location.search).get("project");
    if (!id) return;
    if (!getState().projects.some((project) => project.id === id)) return;

    // Highlight only: which project Build is working on is Build's fact, not
    // something a link on this page should change.
    render();

    const entry = mounted.get(id);
    if (!entry) return;
    entry.node.classList.add("is-highlight");
    window.setTimeout(() => entry.node.classList.remove("is-highlight"), 1600);
    if (typeof entry.node.scrollIntoView === "function") {
      entry.node.scrollIntoView({ block: "center", behavior: BM.prefersReducedMotion() ? "auto" : "smooth" });
    }
    const project = getState().projects.find((item) => item.id === id);
    announce(`${project ? project.name : "Project"} — ${model().lastBuildLabel(project, Date.now())}`);
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */
  function init() {
    cache();
    bindEvents();

    // The list is normally loaded by boot(); reload when this page arrives
    // before that (or after a full navigation) so the view is never empty by
    // accident.
    if (!getState().projects.length) {
      controller().load().then(() => highlightDeepLink());
    } else {
      highlightDeepLink();
    }

    subscribe((view, changed) => {
      if (
        !changed.length ||
        changed.includes("projects") ||
        changed.includes("projectsFilter") ||
        changed.includes("projectsQuery") ||
        changed.includes("activeProjectId")
      ) {
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
