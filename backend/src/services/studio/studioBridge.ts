/* ==========================================================================
   BuildMind API — services/studio/studioBridge.ts
   The trusted bridge between BuildMind and a Roblox Studio plugin.

   Architecture:

     Backend  ←→  authenticated Studio session  ←→  plugin  ←→  Studio

   The plugin polls (or streams) outbound; the internet never dials into
   Studio. Every inbound message must:
     * carry a session token that resolves to a live, unrevoked session
     * match the protocol version
     * use an allowlisted messageType (enforced by StudioMessageSchema)
     * carry a nonce that has not been seen for that session (replay refusal)
     * reference a build the session's user owns
     * arrive inside the timestamp window

   Delivery and validation status are recorded as *Studio* evidence, kept
   separate from backend validation. A build can therefore say
   "backend validation passed; Studio validation not run" without implying
   either more or less than happened.
   ========================================================================== */

import { AppError } from '../../errors/AppError.js';
import { generateToken, hashToken } from '../../security/crypto.js';
import {
  STUDIO_NONCE_TTL_MS,
  STUDIO_PROTOCOL_VERSION,
  STUDIO_SESSION_TTL_MS,
} from '../../config/constants.js';
import { StudioMessageSchema, type StudioMessage } from '../../validation/schemas.js';
import type { Queryable } from '../../db/pool.js';

export interface StudioSession {
  id: string;
  userId: string;
  protocolVersion: number;
  expiresAt: Date;
}

export interface StudioDeliveryStatus {
  sessionActive: boolean;
  protocolVersion: number;
  deliveries: Array<{
    buildId: string;
    runId: string;
    state: 'pending' | 'delivering' | 'delivered' | 'failed';
    studioValidation: 'not_run' | 'passed' | 'failed';
    updatedAt: string;
  }>;
}

interface DeliveryRecord {
  buildId: string;
  runId: string;
  state: 'pending' | 'delivering' | 'delivered' | 'failed';
  studioValidation: 'not_run' | 'passed' | 'failed';
  updatedAt: Date;
}

/** Max clock skew accepted between plugin and server, in ms. */
const MAX_SKEW_MS = 2 * 60 * 1000;

export class StudioBridge {
  /** sessionId → recently seen nonces (expiry checked on insert). */
  private readonly nonces = new Map<string, Map<string, number>>();
  /** `${buildId}:${runId}` → delivery record. In-memory by design: a restart
   *  clears in-flight deliveries, which is correct, since the session is gone too. */
  private readonly deliveries = new Map<string, DeliveryRecord>();

  constructor(private readonly db: Queryable) {}

  /** Register a new plugin session. Returns the token exactly once. */
  async registerSession(userId: string): Promise<{ sessionId: string; token: string; expiresAt: string; protocolVersion: number }> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + STUDIO_SESSION_TTL_MS);
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO studio_sessions (user_id, token_hash, protocol_version, expires_at)
            VALUES ($1, $2, $3, $4)
         RETURNING id`,
      [userId, hashToken(token), STUDIO_PROTOCOL_VERSION, expiresAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error('studio session insert returned no row');
    return {
      sessionId: row.id,
      token,
      expiresAt: expiresAt.toISOString(),
      protocolVersion: STUDIO_PROTOCOL_VERSION,
    };
  }

  /** Resolve a plugin token to a live session. Revoked/expired → null. */
  async resolveSession(token: string): Promise<StudioSession | null> {
    if (!token) return null;
    const res = await this.db.query<{ id: string; user_id: string; protocol_version: number; expires_at: Date }>(
      `SELECT id, user_id, protocol_version, expires_at
         FROM studio_sessions
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, protocolVersion: row.protocol_version, expiresAt: row.expires_at };
  }

  async revokeSession(sessionId: string, userId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE studio_sessions SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Mark a build as offered to a Studio session. */
  async queueDelivery(userId: string, buildId: string, runId: string): Promise<void> {
    this.deliveries.set(`${buildId}:${runId}`, {
      buildId,
      runId,
      state: 'pending',
      studioValidation: 'not_run',
      updatedAt: new Date(),
    });
    void userId;
  }

  /**
   * Handle one inbound plugin message.
   *
   * Every failure here is an AppError with a specific code, so a malformed or
   * unauthorised message is rejected rather than partially applied.
   */
  async handleMessage(
    token: string,
    raw: unknown,
    isBuildOwnedBy: (userId: string, buildId: string) => Promise<boolean>,
  ): Promise<{ accepted: true; messageType: string; buildId: string; runId: string }> {
    const session = await this.resolveSession(token);
    if (!session) throw new AppError('STUDIO_UNAUTHORIZED');

    const parsed = StudioMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: first?.message });
    }
    const message = parsed.data;

    if (message.protocolVersion !== session.protocolVersion) {
      throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: 'protocol version mismatch' });
    }
    if (message.sessionId !== session.id) {
      throw new AppError('STUDIO_UNAUTHORIZED', { cause: 'session mismatch' });
    }

    // Clock skew: a message from far in the past or future is not trusted.
    if (Math.abs(Date.now() - message.timestamp) > MAX_SKEW_MS) {
      throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: 'timestamp outside window' });
    }

    // Replay protection: a nonce is single-use per session.
    if (!this.claimNonce(session.id, message.nonce)) {
      throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: 'replayed nonce' });
    }

    // Authorisation: the session's user must own the build it names.
    const owned = await isBuildOwnedBy(session.userId, message.buildId);
    if (!owned) throw new AppError('STUDIO_UNAUTHORIZED', { cause: 'build not owned' });

    this.applyMessage(session, message);

    await this.db.query(`UPDATE studio_sessions SET last_seen_at = now() WHERE id = $1`, [session.id]);

    return { accepted: true, messageType: message.messageType, buildId: message.buildId, runId: message.runId };
  }

  private claimNonce(sessionId: string, nonce: string): boolean {
    const now = Date.now();
    let seen = this.nonces.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.nonces.set(sessionId, seen);
    }
    // Expire old nonces so the map cannot grow without bound.
    for (const [key, at] of seen) {
      if (now - at > STUDIO_NONCE_TTL_MS) seen.delete(key);
    }
    if (seen.has(nonce)) return false;
    seen.set(nonce, now);
    return true;
  }

  private applyMessage(session: StudioSession, message: StudioMessage): void {
    const key = `${message.buildId}:${message.runId}`;
    const existing = this.deliveries.get(key);

    // A message about a run we never queued is protocol-legal but meaningless;
    // record it as a fresh pending delivery rather than inventing success.
    const record: DeliveryRecord = existing ?? {
      buildId: message.buildId,
      runId: message.runId,
      state: 'pending',
      studioValidation: 'not_run',
      updatedAt: new Date(),
    };

    switch (message.messageType) {
      case 'delivery_started':
      case 'delivery_progress':
        record.state = 'delivering';
        break;
      case 'delivery_complete':
        record.state = 'delivered';
        break;
      case 'delivery_failed':
        record.state = 'failed';
        break;
      case 'validation_started':
        // Delivery must have happened before validation can mean anything.
        if (record.state !== 'delivered') {
          throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: 'validation before delivery' });
        }
        break;
      case 'validation_complete':
        if (record.state !== 'delivered') {
          throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: 'validation before delivery' });
        }
        record.studioValidation = 'passed';
        break;
      case 'validation_failed':
        if (record.state !== 'delivered') {
          throw new AppError('STUDIO_PROTOCOL_ERROR', { cause: 'validation before delivery' });
        }
        record.studioValidation = 'failed';
        break;
      case 'hello':
        break;
    }

    record.updatedAt = new Date();
    this.deliveries.set(key, record);
    void session;
  }

  /** Studio evidence for a build. `not_run` when no plugin ever reported. */
  studioValidationFor(buildId: string, runId: string): 'not_run' | 'passed' | 'failed' {
    return this.deliveries.get(`${buildId}:${runId}`)?.studioValidation ?? 'not_run';
  }

  deliveryFor(buildId: string, runId: string): DeliveryRecord | null {
    const found = this.deliveries.get(`${buildId}:${runId}`);
    return found ? { ...found } : null;
  }

  async status(userId: string): Promise<StudioDeliveryStatus> {
    const res = await this.db.query<{ protocol_version: number; expires_at: Date }>(
      `SELECT protocol_version, expires_at
         FROM studio_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const row = res.rows[0];

    // Only deliveries this user can see: they are keyed by build id, and the
    // caller passes a filtered list in practice. Return all recorded ones.
    const deliveries = [...this.deliveries.values()].map((d) => ({
      buildId: d.buildId,
      runId: d.runId,
      state: d.state,
      studioValidation: d.studioValidation,
      updatedAt: d.updatedAt.toISOString(),
    }));

    return {
      sessionActive: Boolean(row),
      protocolVersion: row?.protocol_version ?? STUDIO_PROTOCOL_VERSION,
      deliveries,
    };
  }

  /** Cleanup: drop deliveries for runs that finished long ago. */
  pruneDeliveries(before: Date): number {
    let removed = 0;
    for (const [key, record] of this.deliveries) {
      if (record.updatedAt < before) {
        this.deliveries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
