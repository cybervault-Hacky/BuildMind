-- ==========================================================================
-- 002_active_build_unique.sql — Enforce at most one non-terminal build per
-- project at the database boundary, closing the check-then-insert race under
-- concurrent POST /api/v1/builds requests.
-- ==========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS builds_one_active_per_project_idx
  ON builds (project_id)
  WHERE status NOT IN ('complete','failed','cancelled');
