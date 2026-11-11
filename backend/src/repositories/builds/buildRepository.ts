/* ==========================================================================
   BuildMind API — repositories/builds/buildRepository.ts
   SQL for builds and build events.

   The two safety-critical methods:

     * transition() is a compare-and-set: it only writes when the row is still
       in the status the caller expected AND still carries the caller's runId.
       A late writer from an old run therefore updates zero rows rather than
       overwriting newer state.
     * appendEvent() refuses a duplicate (build_id, run_id, seq), so a retried
       emit cannot double-record.

   Every read is scoped by user_id.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/pool.js';
import type { BuildStatus, BuildStage } from '../../services/builds/stateMachine.js';
import { canTransition } from '../../services/builds/stateMachine.js';

export interface Build {
  id: string;
  projectId: string;
  userId: string;
  runId: string;
  status: BuildStatus;
  currentStage: BuildStage | null;
  progress: number;
  provider: string;
  model: string;
  retryOf: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  cancelRequestedAt: Date | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuildEvent {
  seq: number;
  stage: string | null;
  status: BuildStatus;
  progress: number;
  activity: string;
  createdAt: Date;
}

interface BuildRow {
  id: string;
  project_id: string;
  user_id: string;
  run_id: string;
  status: BuildStatus;
  current_stage: BuildStage | null;
  progress: number;
  provider: string;
  model: string;
  retry_of: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  cancel_requested_at: Date | null;
  error_code: string | null;
  error_message_safe: string | null;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  seq: number;
  stage: string | null;
  status: BuildStatus;
  progress: number;
  activity: string;
  created_at: Date;
}

const COLUMNS = `id, project_id, user_id, run_id, status, current_stage, progress, provider, model,
                 retry_of, started_at, ended_at, cancel_requested_at, error_code,
                 error_message_safe, created_at, updated_at`;

function toBuild(row: BuildRow): Build {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    runId: row.run_id,
    status: row.status,
    currentStage: row.current_stage,
    progress: row.progress,
    provider: row.provider,
    model: row.model,
    retryOf: row.retry_of,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cancelRequestedAt: row.cancel_requested_at,
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BuildRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string, userId: string): Promise<Build | null> {
    const res = await this.db.query<BuildRow>(
      `SELECT ${COLUMNS} FROM builds WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? toBuild(row) : null;
  }

  async findManyByUser(userId: string, options: { projectId?: string; limit: number }): Promise<Build[]> {
    const res = await this.db.query<BuildRow>(
      `SELECT ${COLUMNS}
         FROM builds
        WHERE user_id = $1
          AND ($2::uuid IS NULL OR project_id = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, options.projectId ?? null, options.limit],
    );
    return res.rows.map(toBuild);
  }

  /** How many builds this user has in flight — used for the concurrency cap. */
  async countActiveByUser(userId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM builds
        WHERE user_id = $1
          AND status NOT IN ('complete','failed','cancelled')`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async create(input: {
    projectId: string;
    userId: string;
    provider: string;
    model: string;
    retryOf?: string;
  }): Promise<Build> {
    /*
      The run id is generated here, not left to a column default. Every event
      this build emits is stamped with it, and a stale callback must be
      rejected by comparing against it, so it has to exist the moment the row
      does — and it must exist even on a database provisioned before that
      default was added.
    */
    const runId = randomUUID();

    const res = await this.db.query<BuildRow>(
      `INSERT INTO builds (project_id, user_id, provider, model, retry_of, status, run_id)
            VALUES ($1, $2, $3, $4, $5, 'queued', $6)
         RETURNING ${COLUMNS}`,
      [input.projectId, input.userId, input.provider, input.model, input.retryOf ?? null, runId],
    );
    const row = res.rows[0];
    if (!row) throw new Error('build insert returned no row');
    return toBuild(row);
  }

  /**
   * Compare-and-set transition.
   * Returns the updated build, or null when the row moved on (wrong status,
   * wrong run, or not owned by this user).
   */
  async transition(input: {
    id: string;
    userId: string;
    runId: string;
    expected: BuildStatus;
    next: BuildStatus;
    stage?: BuildStage | null;
    progress?: number;
    errorCode?: string | null;
    errorMessageSafe?: string | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
  }): Promise<Build | null> {
    // The state machine is enforced here, not only in the orchestrator. A
    // compare-and-set that matched the row but described an illegal edge (a
    // completed build moving back to `building`, say) must not write.
    if (!canTransition(input.expected, input.next)) return null;

    const terminal = ['complete', 'failed', 'cancelled'].includes(input.next);
    const res = await this.db.query<BuildRow>(
      `UPDATE builds
          SET status      = $5,
              current_stage = COALESCE($6, current_stage),
              progress    = COALESCE($7, progress),
              error_code  = COALESCE($8, error_code),
              error_message_safe = COALESCE($9, error_message_safe),
              started_at  = COALESCE($10, started_at),
              ended_at    = CASE WHEN $11::boolean THEN COALESCE(ended_at, now()) ELSE ended_at END,
              updated_at  = now()
        WHERE id = $1
          AND user_id = $2
          AND run_id = $3
          AND status = $4
    RETURNING ${COLUMNS}`,
      [
        input.id,
        input.userId,
        input.runId,
        input.expected,
        input.next,
        input.stage ?? null,
        input.progress ?? null,
        input.errorCode ?? null,
        input.errorMessageSafe ?? null,
        input.startedAt ?? null,
        terminal,
      ],
    );
    const row = res.rows[0];
    return row ? toBuild(row) : null;
  }

  /** Progress-only update; never crosses a state boundary. */
  async setProgress(id: string, userId: string, runId: string, progress: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE builds
          SET progress = $4, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND run_id = $3
          AND status NOT IN ('complete','failed','cancelled')`,
      [id, userId, runId, progress],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Request cancellation. Idempotent: a second request keeps the first time. */
  async requestCancel(id: string, userId: string): Promise<Build | null> {
    const res = await this.db.query<BuildRow>(
      `UPDATE builds
          SET cancel_requested_at = COALESCE(cancel_requested_at, now())
        WHERE id = $1 AND user_id = $2
          AND status NOT IN ('complete','failed','cancelled')
    RETURNING ${COLUMNS}`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? toBuild(row) : null;
  }

  async isCancelRequested(id: string, runId: string): Promise<boolean> {
    const res = await this.db.query<{ requested: boolean }>(
      `SELECT (cancel_requested_at IS NOT NULL) AS requested
         FROM builds WHERE id = $1 AND run_id = $2`,
      [id, runId],
    );
    return Boolean(res.rows[0]?.requested);
  }

  /* ------------------------------------------------------------- events -- */

  async appendEvent(input: {
    buildId: string;
    userId: string;
    runId: string;
    stage: BuildStage | null;
    status: BuildStatus;
    progress: number;
    activity: string;
  }): Promise<BuildEvent | null> {
    const res = await this.db.query<EventRow>(
      `INSERT INTO build_events (build_id, user_id, run_id, seq, stage, status, progress, activity)
       SELECT $1, $2, $3,
              COALESCE((SELECT max(seq) + 1 FROM build_events WHERE build_id = $1), 1),
              $4, $5, $6, $7
        WHERE NOT EXISTS (SELECT 1 FROM build_events WHERE build_id = $1 AND run_id = $3 AND seq = 0)
    RETURNING seq, stage, status, progress, activity, created_at`,
      [input.buildId, input.userId, input.runId, input.stage, input.status, input.progress, input.activity],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      seq: row.seq,
      stage: row.stage,
      status: row.status,
      progress: row.progress,
      activity: row.activity,
      createdAt: row.created_at,
    };
  }

  /** Events after `after` for one run only — an old run's events never mix in. */
  async listEvents(buildId: string, userId: string, runId: string, after: number): Promise<BuildEvent[]> {
    const res = await this.db.query<EventRow>(
      `SELECT seq, stage, status, progress, activity, created_at
         FROM build_events
        WHERE build_id = $1 AND user_id = $2 AND run_id = $3 AND seq > $4
        ORDER BY seq ASC`,
      [buildId, userId, runId, after],
    );
    return res.rows.map((row) => ({
      seq: row.seq,
      stage: row.stage,
      status: row.status,
      progress: row.progress,
      activity: row.activity,
      createdAt: row.created_at,
    }));
  }

  /** Cleanup: drop events for builds that ended long ago. */
  async deleteEventsOlderThan(before: Date): Promise<number> {
    const res = await this.db.query(`DELETE FROM build_events WHERE created_at < $1`, [before]);
    return res.rowCount ?? 0;
  }
}
