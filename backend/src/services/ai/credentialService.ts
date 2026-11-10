/* ==========================================================================
   BuildMind API — services/ai/credentialService.ts
   BYOK credential handling: the one place a provider key exists in plaintext.

   Session-scoped, not permanently persisted. The rule from the frontend phase
   is preserved: the key is available while the user is working and gone
   afterwards. A credential is sealed with `expires_at` a short time ahead
   (BYOK_TTL_MS) and every read filters on it, so a stale key cannot outlive
   the session that supplied it even if the row is never actively deleted.

   What this file guarantees:
     * no method returns a plaintext key to a caller outside the provider layer
     * the key is bound to its owner via AAD, so a copied row fails to decrypt
     * only a non-reversible hint is ever exposed for display
   ========================================================================== */

import { AppError } from '../../errors/AppError.js';
import { EnvelopeCipher, keyHint } from '../../security/crypto.js';
import { CredentialRepository } from '../../repositories/credentials/credentialRepository.js';
import type { Queryable } from '../../db/pool.js';
import type { ProviderCredential } from '../../providers/ai/types.js';
import type { ProviderRegistry } from '../../providers/ai/registry.js';

/** How long a supplied BYOK key stays usable. Session-scoped by design. */
export const BYOK_TTL_MS = 12 * 60 * 60 * 1000;

export interface CredentialSummary {
  provider: string;
  keyHint: string;
  expiresAt: string;
}

export class CredentialService {
  private readonly cipher: EnvelopeCipher;
  private readonly repo: CredentialRepository;

  constructor(
    db: Queryable,
    encryptionKey: string,
    private readonly registry: ProviderRegistry,
  ) {
    this.cipher = new EnvelopeCipher(encryptionKey);
    this.repo = new CredentialRepository(db);
  }

  /** Bind ciphertext to the user *and* provider so a swap fails to open. */
  private aad(userId: string, provider: string): string {
    return `bm:cred:${userId}:${provider}`;
  }

  /**
   * Store a key the user just supplied. Never returns the key — not the whole
   * value, not a prefix beyond the 3-character display hint.
   */
  async store(userId: string, provider: string, apiKey: string): Promise<CredentialSummary> {
    const sealed = this.cipher.seal(apiKey, this.aad(userId, provider));
    const expiresAt = new Date(Date.now() + BYOK_TTL_MS);
    const hint = keyHint(apiKey);
    await this.repo.upsert({
      userId,
      provider,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      keyHint: hint,
      expiresAt,
    });
    return { provider, keyHint: hint, expiresAt: expiresAt.toISOString() };
  }

  async list(userId: string): Promise<CredentialSummary[]> {
    const rows = await this.repo.listMetadata(userId);
    return rows.map((r) => ({ provider: r.provider, keyHint: r.keyHint, expiresAt: r.expiresAt.toISOString() }));
  }

  async forget(userId: string, provider: string): Promise<boolean> {
    return this.repo.delete(userId, provider);
  }

  /**
   * Resolve the credential to use for a provider call.
   *
   * A supplied key wins. Otherwise a stored BYOK key is used. Otherwise, if
   * BuildMind holds a managed key, it is used and clearly labelled — the
   * caller can tell which path ran.
   *
   * Returns null when nothing is available; the caller decides how to report
   * that. It never silently substitutes a mock.
   */
  async resolve(userId: string, provider: string, suppliedKey?: string): Promise<ProviderCredential | null> {
    if (suppliedKey) return { apiKey: suppliedKey, source: 'byok' };

    const stored = await this.repo.find(userId, provider);
    if (stored) {
      let plaintext: string;
      try {
        plaintext = this.cipher.open(
          { ciphertext: stored.ciphertext, iv: stored.iv, authTag: stored.authTag },
          this.aad(userId, provider),
        );
      } catch (err) {
        // A row that cannot be authenticated is unusable — drop it rather than
        // retrying forever, and report a configuration problem, not a 500.
        await this.repo.delete(userId, provider);
        throw new AppError('CONFIGURATION_ERROR', { cause: err });
      }
      await this.repo.touch(userId, provider);
      return { apiKey: plaintext, source: 'byok' };
    }

    const managed = this.registry.managedKey(provider);
    if (managed) return { apiKey: managed, source: 'managed' };

    return null;
  }

  /** True when some credential exists, without decrypting anything. */
  async hasAny(userId: string, provider: string, suppliedKey?: string): Promise<boolean> {
    if (suppliedKey) return true;
    if (this.registry.hasManagedKey(provider)) return true;
    return (await this.repo.find(userId, provider)) !== null;
  }
}
