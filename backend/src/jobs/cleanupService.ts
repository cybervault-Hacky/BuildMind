/* ==========================================================================
   BuildMind API — jobs/cleanupService.ts
   Scheduled cleanup. Every sweep is bounded and never touches user projects.

   What is cleaned:
     * expired sessions (rows past expires_at)
     * abandoned active builds (a crashed worker's leftovers)
     * old build events
     * expired BYOK credentials
     * expired Studio sessions
     * stale build workspaces on disk

   What is NOT cleaned, ever:
     * projects — they are user data; only the user deletes those
     * completed builds — they are the record of what happened
   ========================================================================== */

import {
  BUILD_EVENT_RETENTION_MS,
  SESSION_TTL_MS,
  STUDIO_SESSION_TTL_MS,
  WORKSPACE_RETENTION_MS,
} from '../config/constants.js';
import type { Logger } from '../utils/logger.js';
import type { Queryable } from '../db/pool.js';
import type { WorkspaceManager } from '../workspace/workspaceManager.js';
import type { AuthService } from '../services/auth/authService.js';
import type { StudioBridge } from '../services/studio/studioBridge.js';

export interface CleanupReport {
  sessions: number;
  abandonedBuilds: number;
  events: number;
  credentials: number;
  studioSessions: number;
  workspaces: number;
}

export class CleanupService {
  constructor(
    private readonly db: Queryable,
    private readonly auth: AuthService,
    private readonly workspace: WorkspaceManager,
    private readonly studio: StudioBridge,
    private readonly logger: Logger,
  ) {}

  /** One full sweep. Safe to run concurrently with traffic. */
  async run(now = new Date()): Promise<CleanupReport> {
    const sessions = await this.auth.pruneExpired(new Date(now.getTime() - SESSION_TTL_MS));

    // A build that has not been touched for longer than a workspace lifetime
    // and is still active has no worker behind it.
    const abandoned = await this.db.query(
      `UPDATE builds
          SET status = 'failed',
              error_code = 'BUILD_TIMEOUT',
              error_message_safe = 'The build ran out of time.',
              ended_at = now(),
              updated_at = now()
        WHERE status NOT IN ('complete','failed','cancelled')
          AND updated_at < $1`,
      [new Date(now.getTime() - WORKSPACE_RETENTION_MS)],
    );

    const events = await this.db.query(`DELETE FROM build_events WHERE created_at < $1`, [
      new Date(now.getTime() - BUILD_EVENT_RETENTION_MS),
    ]);

    const credentials = await this.db.query(`DELETE FROM provider_credentials WHERE expires_at <= now()`);

    const studioSessions = await this.db.query(
      `UPDATE studio_sessions SET revoked_at = now()
        WHERE revoked_at IS NULL AND expires_at < $1`,
      [new Date(now.getTime() - STUDIO_SESSION_TTL_MS)],
    );

    const removedWorkspaces = await this.workspace.pruneBefore(new Date(now.getTime() - WORKSPACE_RETENTION_MS));
    this.studio.pruneDeliveries(new Date(now.getTime() - WORKSPACE_RETENTION_MS));

    const report: CleanupReport = {
      sessions,
      abandonedBuilds: abandoned.rowCount ?? 0,
      events: events.rowCount ?? 0,
      credentials: credentials.rowCount ?? 0,
      studioSessions: studioSessions.rowCount ?? 0,
      workspaces: removedWorkspaces.length,
    };

    this.logger.info({ event: 'cleanup.completed', ...report });
    return report;
  }
}
