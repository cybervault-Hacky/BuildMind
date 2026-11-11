/* ==========================================================================
   BuildMind — services/projects/projectModel.js
   Pure project helpers shared by the project service and the Projects
   renderer. No state, no storage, no DOM: every function takes data and
   returns data, which keeps the lifecycle vocabulary in one place.

   Why this file exists: the card, the filter row and the stored record must
   agree on what a status means, how old a build is, and what a description
   looks like. Defining that once here means the service can normalise a
   record the same way the renderer reads it.

   Nothing here invents data. Times come from stored timestamps, descriptions
   come from the prompt the user wrote, and a project with no completed build
   has no last-build time at all.
   ========================================================================== */

(function () {
  "use strict";

  const BM = window.BuildMind;
  if (!BM) return;

  const MAX_DESCRIPTION = 96;
  const MAX_PROMPT = 600;

  /* ------------------------------------------------------------------------
     Timestamps → short relative labels. Deterministic, no library.
     ---------------------------------------------------------------------- */
  function relativeTime(at, now) {
    const stamp = Number(at);
    if (!Number.isFinite(stamp) || stamp <= 0) return "";
    const reference = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const diff = Math.max(0, reference - stamp);
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return "Just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 45) return `${minutes} minutes ago`;

    const hours = Math.round(minutes / 60);
    if (hours <= 1) return "1 hour ago";
    if (hours < 22) return `${hours} hours ago`;

    const days = Math.round(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;

    const weeks = Math.round(days / 7);
    if (weeks === 1) return "1 week ago";
    if (weeks < 5) return `${weeks} weeks ago`;

    const months = Math.round(days / 30);
    return months <= 1 ? "1 month ago" : `${months} months ago`;
  }

  /**
   * Older records stored the label itself ("2 days ago"). Parse it back into a
   * timestamp once, so nothing downstream has to keep re-reading a stale
   * string. Unrecognised text yields null and the caller keeps no time.
   */
  function parseLegacyLabel(text, now) {
    const label = String(text || "").trim().toLowerCase();
    if (!label) return null;
    const reference = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (label === "just now") return reference;
    if (label === "yesterday") return reference - 86400000;

    const match = label.match(/^(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago$/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];
    const size = {
      second: 1000,
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2592000000,
    }[unit];
    if (!size) return null;
    return reference - amount * size;
  }

  /* ------------------------------------------------------------------------
     Descriptions — a short, honest restatement of the user's own prompt.
     ---------------------------------------------------------------------- */
  function describeFromPrompt(prompt) {
    let text = String(prompt === undefined || prompt === null ? "" : prompt)
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return "";
    // Drop the instruction wrapper, keep the idea ("Create an obby with…").
    text = text
      .replace(/^(please\s+)?(create|make|build|design|generate)\s+(me\s+)?(a|an|the)?\s*/i, "")
      .replace(/[.!?]+$/g, "")
      .trim();

    if (!text) return "";
    const first = text.charAt(0);
    text = first.toUpperCase() + text.slice(1);

    if (text.length <= MAX_DESCRIPTION) return text;
    const cut = text.slice(0, MAX_DESCRIPTION);
    const boundary = cut.lastIndexOf(" ");
    return `${(boundary > 40 ? cut.slice(0, boundary) : cut).trim()}…`;
  }

  function safePrompt(prompt) {
    return String(prompt === undefined || prompt === null ? "" : prompt)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, MAX_PROMPT);
  }

  /* ------------------------------------------------------------------------
     Card copy — every label is derived from stored facts.
     ---------------------------------------------------------------------- */
  /**
   * The one line the card shows about time. It states the last successful
   * build whenever there is one; when there is none, it reports the most
   * recent real event instead of pretending a build happened.
   */
  function lastBuildLabel(project, now) {
    if (!project) return "";
    const events = Array.isArray(project.history) ? project.history : [];
    const latest = events.length ? events[events.length - 1] : null;

    if (project.lastBuildAt) {
      const when = relativeTime(project.lastBuildAt, now);
      return when ? `Last build: ${when}` : "Not built yet";
    }

    if (latest && (latest.type === "stopped" || latest.type === "error")) {
      const when = relativeTime(latest.at, now);
      const copy = latest.type === "error" ? "Build failed" : "Build stopped";
      return when ? `${copy} ${when.toLowerCase()}` : copy;
    }

    return "Not built yet";
  }

  /** Human copy per project event — only events the frontend really produces. */
  const EVENT_COPY = {
    created: "Created",
    complete: "Build completed",
    stopped: "Build stopped",
    error: "Build failed",
  };

  function statusMeta(status) {
    const table = BM.PROJECT_STATUS || {};
    return table[status] || table.draft || { label: "Draft", tone: "idle" };
  }

  function isBuilt(project) {
    return Boolean(project && project.lastBuildAt);
  }

  /* ------------------------------------------------------------------------
     Ordering and search
     ---------------------------------------------------------------------- */
  function sortKey(project) {
    if (!project) return 0;
    return Number(project.lastBuildAt || project.updatedAt || project.created || 0);
  }

  function sortProjects(projects) {
    return (Array.isArray(projects) ? projects.slice() : []).sort((a, b) => {
      const delta = sortKey(b) - sortKey(a);
      if (delta !== 0) return delta;
      // Stable tiebreak on id keeps the order deterministic between renders.
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /** Search matches name and description only — never prompts or settings. */
  function matchesQuery(project, query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return true;
    if (!project) return false;
    const haystack = `${project.name || ""} ${project.description || ""}`.toLowerCase();
    return needle.split(/\s+/).every((word) => haystack.indexOf(word) !== -1);
  }

  BM.projectModel = {
    MAX_DESCRIPTION,
    MAX_PROMPT,
    relativeTime,
    parseLegacyLabel,
    describeFromPrompt,
    safePrompt,
    lastBuildLabel,
    EVENT_COPY,
    statusMeta,
    isBuilt,
    sortProjects,
    matchesQuery,
  };
})();
