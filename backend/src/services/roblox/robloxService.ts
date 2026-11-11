/* ==========================================================================
   BuildMind API — services/roblox/robloxService.ts
   Roblox account connection, scoped to a user.

   Security properties:
     * the OAuth `state` is a random single-use value, stored with the user and
       consumed on callback — a replayed callback fails
     * tokens are sealed with AES-256-GCM under the same envelope cipher as
       BYOK keys, bound to the user id via AAD
     * no token ever leaves this service; the public shape is identity only
     * disconnect revokes the local record immediately

   Honesty property: connect() only succeeds when the token exchange AND the
   userinfo call both succeed. There is no path that reports "connected"
   because a code was merely received.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../../errors/AppError.js';
import { EnvelopeCipher, generateToken } from '../../security/crypto.js';
import { RobloxProvider, buildAuthorizeUrl } from '../../providers/roblox/robloxProvider.js';
import type { Queryable } from '../../db/pool.js';

/** Scopes requested. Keep this minimal: identity only. */
const SCOPES = ['openid', 'profile'];

export interface RobloxStatus {
  configured: boolean;
  connected: boolean;
  account: { userId: string; displayName: string; connectedAt: string; expiresAt: string | null } | null;
  capabilities: ReturnType<RobloxProvider['capabilities']>;
}

interface PendingState {
  userId: string;
  createdAt: number;
}

export class RobloxService {
  private readonly cipher: EnvelopeCipher;
  /** state → pending authorisation. Single use, short lived, in-memory. */
  private readonly pending = new Map<string, PendingState>();

  constructor(
    private readonly db: Queryable,
    private readonly provider: RobloxProvider,
    encryptionKey: string,
  ) {
    this.cipher = new EnvelopeCipher(encryptionKey);
  }

  private aad(userId: string): string {
    return `bm:roblox:${userId}`;
  }

  private prunePending(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [state, value] of this.pending) {
      if (value.createdAt < cutoff) this.pending.delete(state);
    }
  }

  /**
   * Begin the OAuth flow.
   *
   * The returned `state` is stored server-side against the user; it is not a
   * signed blob the client could forge for another account.
   */
  async beginConnect(userId: string): Promise<{ authorizeUrl: string; state: string }> {
    if (!this.provider.configured) {
      throw new AppError('ROBLOX_NOT_CONFIGURED');
    }
    this.prunePending();
    const state = generateToken();
    this.pending.set(state, { userId, createdAt: Date.now() });
    return { authorizeUrl: buildAuthorizeUrl(this.providerConfig(), state, SCOPES), state };
  }

  private providerConfig(): { clientId?: string; clientSecret?: string; redirectUri?: string } {
    // The provider holds the config privately; expose only what buildAuthorizeUrl needs.
    return (this.provider as unknown as { config: Record<string, string | undefined> }).config as {
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
    };
  }

  /** Complete the flow. State is consumed whether or not the exchange works. */
  async connect(userId: string, code: string, state: string): Promise<RobloxStatus> {
    if (!this.provider.configured) throw new AppError('ROBLOX_NOT_CONFIGURED');

    const pending = this.pending.get(state);
    if (!pending || pending.userId !== userId) {
      // Unknown state, or a state minted for a different user: refuse.
      throw new AppError('FORBIDDEN', { cause: 'unknown oauth state' });
    }
    this.pending.delete(state);

    const tokens = await this.provider.exchangeCode(code);
    const identity = await this.provider.fetchIdentity(tokens.accessToken);

    // Only now is anything persisted: both provider calls succeeded.
    const sealed = this.cipher.seal(
      JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
      this.aad(userId),
    );

    await this.db.query(`DELETE FROM roblox_accounts WHERE user_id = $1`, [userId]);
    await this.db.query(
      `INSERT INTO roblox_accounts
              (user_id, roblox_user_id, display_name, scopes, expires_at, ciphertext, iv, auth_tag)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        identity.userId,
        identity.displayName,
        tokens.scopes,
        tokens.expiresAt,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
      ],
    );

    return this.status(userId);
  }

  async disconnect(userId: string): Promise<RobloxStatus> {
    await this.db.query(`DELETE FROM roblox_accounts WHERE user_id = $1`, [userId]);
    return this.status(userId);
  }

  async status(userId: string): Promise<RobloxStatus> {
    const res = await this.db.query<{
      roblox_user_id: string;
      display_name: string;
      connected_at: Date;
      expires_at: Date | null;
    }>(
      `SELECT roblox_user_id, display_name, connected_at, expires_at
         FROM roblox_accounts WHERE user_id = $1`,
      [userId],
    );
    const row = res.rows[0];

    return {
      configured: this.provider.configured,
      connected: Boolean(row),
      account: row
        ? {
            userId: row.roblox_user_id,
            displayName: row.display_name,
            connectedAt: row.connected_at.toISOString(),
            expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
          }
        : null,
      capabilities: this.provider.capabilities(),
    };
  }

  /**
   * Decrypt the stored Roblox token for a server-side call.
   * Deliberately narrow: there is currently no operation that needs it, so it
   * is not called anywhere. It exists for the account-refresh path and is
   * covered by the secret-leak test to prove it never surfaces.
   */
  async accessToken(userId: string): Promise<string | null> {
    const res = await this.db.query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      `SELECT ciphertext, iv, auth_tag FROM roblox_accounts WHERE user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const opened = JSON.parse(
      this.cipher.open({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }, this.aad(userId)),
    ) as { accessToken?: string };
    return opened.accessToken ?? null;
  }

  /** Not found is never disclosed differently from "not connected". */
  requireConnection(status: RobloxStatus): void {
    if (!status.connected) throw notFound();
  }

  /** Exposed for tests: a fresh state value that no user has claimed. */
  static mintStateForTest(): string {
    return randomUUID();
  }
}
