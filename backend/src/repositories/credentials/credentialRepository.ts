/* ==========================================================================
   BuildMind API — repositories/credentials/credentialRepository.ts
   Storage for BYOK provider credentials.

   The repository only ever handles sealed values: it has no method that
   accepts or returns a plaintext key. Decryption lives in the credential
   service, which is also the only caller that knows the associated data.
   ========================================================================== */

import type { Queryable } from '../../db/pool.js';

export interface SealedCredential {
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyHint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

interface CredentialRow {
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_hint: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
}

function toCredential(row: CredentialRow): SealedCredential {
  return {
    provider: row.provider,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    keyHint: row.key_hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

export class CredentialRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(input: {
    userId: string;
    provider: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyHint: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO provider_credentials
              (user_id, provider, ciphertext, iv, auth_tag, key_hint, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, provider) DO UPDATE
              SET ciphertext = EXCLUDED.ciphertext,
                  iv         = EXCLUDED.iv,
                  auth_tag   = EXCLUDED.auth_tag,
                  key_hint   = EXCLUDED.key_hint,
                  expires_at = EXCLUDED.expires_at,
                  created_at = now()`,
      [input.userId, input.provider, input.ciphertext, input.iv, input.authTag, input.keyHint, input.expiresAt],
    );
  }

  async find(userId: string, provider: string): Promise<SealedCredential | null> {
    const res = await this.db.query<CredentialRow>(
      `SELECT provider, ciphertext, iv, auth_tag, key_hint, created_at, last_used_at, expires_at
         FROM provider_credentials
        WHERE user_id = $1 AND provider = $2 AND expires_at > now()`,
      [userId, provider],
    );
    const row = res.rows[0];
    return row ? toCredential(row) : null;
  }

  /** Metadata only: no ciphertext leaves this method. */
  async listMetadata(userId: string): Promise<Array<{ provider: string; keyHint: string; expiresAt: Date }>> {
    const res = await this.db.query<{ provider: string; key_hint: string; expires_at: Date }>(
      `SELECT provider, key_hint, expires_at
         FROM provider_credentials
        WHERE user_id = $1 AND expires_at > now()
        ORDER BY provider`,
      [userId],
    );
    return res.rows.map((r) => ({ provider: r.provider, keyHint: r.key_hint, expiresAt: r.expires_at }));
  }

  async touch(userId: string, provider: string): Promise<void> {
    await this.db.query(
      `UPDATE provider_credentials SET last_used_at = now() WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
  }

  async delete(userId: string, provider: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM provider_credentials WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteExpired(): Promise<number> {
    const res = await this.db.query(`DELETE FROM provider_credentials WHERE expires_at <= now()`);
    return res.rowCount ?? 0;
  }
}
