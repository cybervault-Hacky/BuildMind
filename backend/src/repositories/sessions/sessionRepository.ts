/* ==========================================================================
   BuildMind API — repositories/sessions/sessionRepository.ts
   Sessions are stored by token hash. A row can be revoked; a revoked session
   is rejected by lookup, not by a client-side flag.
   ========================================================================== */

import type { Queryable } from '../../db/pool.js';

export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class SessionRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<Session> {
    const res = await this.db.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
            VALUES ($1, $2, $3)
         RETURNING id, user_id, created_at, last_seen_at, expires_at, revoked_at`,
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error('session insert returned no row');
    return toSession(row);
  }

  /** A valid session is unrevoked and unexpired; anything else is null. */
  async findValidByTokenHash(tokenHash: string): Promise<Session | null> {
    const res = await this.db.query<SessionRow>(
      `SELECT id, user_id, created_at, last_seen_at, expires_at, revoked_at
         FROM sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [tokenHash],
    );
    const row = res.rows[0];
    return row ? toSession(row) : null;
  }

  async touch(id: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  }

  async revoke(id: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
      userId,
    ]);
  }

  /** Cleanup: delete sessions that are long dead. Never touches live ones. */
  async deleteExpired(before: Date): Promise<number> {
    const res = await this.db.query(`DELETE FROM sessions WHERE expires_at < $1`, [before]);
    return res.rowCount ?? 0;
  }
}
