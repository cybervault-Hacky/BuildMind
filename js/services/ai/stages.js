/* ==========================================================================
   BuildMind — services/ai/stages.js
   The seven build stages, defined once.

   Both sides of the boundary read this list:
     • the mock AI service walks it (timing, progress targets, activity lines)
     • the store maps a stage index to a build-machine status
     • the Build renderer paints the timeline, markers and progress from it

   Shape: { id, label, description, status, progress, ms, activity[] }
     label        short name used in the timeline and announcements
     description  one short line explaining what the stage is doing
     status       the build state this stage corresponds to (no second table)
     progress     the authoritative progress target reached at this stage
     activity     simulated log lines emitted while the stage runs
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  const BUILD_STAGES = [
    {
      id: "understand",
      label: "Understanding",
      description: "Analyzing the game idea",
      status: "building",
      progress: 12,
      ms: 1200,
      activity: [
        "Read the game idea",
        "Identified the core gameplay loop",
        "Noted requirements for the world layout",
      ],
    },
    {
      id: "plan",
      label: "Planning",
      description: "Structuring gameplay and systems",
      status: "building",
      progress: 28,
      ms: 1500,
      activity: ["Planned core systems", "Outlined the player journey", "Sketched a scene breakdown"],
    },
    {
      id: "build",
      label: "Building",
      description: "Creating the required game systems",
      status: "building",
      progress: 58,
      ms: 2600,
      activity: ["Structured the world layout", "Defined gameplay systems", "Connected the systems together"],
    },
    {
      id: "test",
      label: "Testing",
      description: "Checking the generated result",
      status: "testing",
      progress: 74,
      ms: 1900,
      activity: ["Checked gameplay systems", "Reviewed logic paths", "Tested the scene flow"],
    },
    {
      id: "fix",
      label: "Fixing",
      description: "Resolving detected issues",
      status: "fixing",
      progress: 84,
      ms: 1700,
      activity: ["Detected an issue", "Applied a fix", "Re-checked the result"],
    },
    {
      id: "validate",
      label: "Validating",
      description: "Performing final checks",
      status: "validating",
      progress: 96,
      ms: 1400,
      activity: ["Checked build consistency", "Confirmed every planned system is present"],
    },
    {
      id: "complete",
      label: "Complete",
      description: "Build finished successfully",
      status: "complete",
      progress: 100,
      ms: 0,
      activity: ["Validation passed", "Build ready for review"],
    },
  ];

  /** Index of the fixing stage, used when a run loops back into testing. */
  const STAGE_INDEX = BUILD_STAGES.reduce((map, stage, index) => {
    map[stage.id] = index;
    return map;
  }, {});

  const LAST_STAGE = BUILD_STAGES.length - 1;

  function stageAt(index) {
    return BUILD_STAGES[index] || null;
  }

  function stageById(id) {
    const index = STAGE_INDEX[id];
    return index === undefined ? null : BUILD_STAGES[index];
  }

  Object.assign(BM, { BUILD_STAGES, LAST_STAGE, STAGE_INDEX, stageAt, stageById });
})();
