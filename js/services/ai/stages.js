/* ==========================================================================
   BuildMind — services/ai/stages.js
   The seven build stages, defined once.

   Both sides of the boundary read this list:
     • the mock AI service walks it (timing and progress values)
     • the store maps a stage index to a build-machine status
     • the Build renderer paints the timeline, markers and progress from it

   Shape: { id, label, status, progress, ms }
   `status` is the build state the stage corresponds to, so no second mapping
   table exists anywhere.
   ========================================================================== */

(function () {
  "use strict";

  const BM = (window.BuildMind = window.BuildMind || {});

  const BUILD_STAGES = [
    { id: "understand", label: "Understanding idea", status: "building", progress: 8, ms: 1100 },
    { id: "plan", label: "Planning", status: "building", progress: 18, ms: 1400 },
    { id: "build", label: "Building", status: "building", progress: 56, ms: 2600 },
    { id: "test", label: "Testing", status: "testing", progress: 78, ms: 2000 },
    { id: "fix", label: "Fixing", status: "fixing", progress: 78, ms: 1700 },
    { id: "validate", label: "Validating", status: "validating", progress: 94, ms: 1400 },
    { id: "complete", label: "Complete", status: "complete", progress: 100, ms: 900 },
  ];

  const LAST_STAGE = BUILD_STAGES.length - 1;
  const RUNNING_STAGES = BUILD_STAGES.slice(0, LAST_STAGE);

  function stageAt(index) {
    return BUILD_STAGES[index] || null;
  }

  Object.assign(BM, { BUILD_STAGES, LAST_STAGE, RUNNING_STAGES, stageAt });
})();
