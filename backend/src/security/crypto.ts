/* ==========================================================================
   BuildMind API — security/crypto.ts
   Password hashing, opaque token generation, and authenticated encryption.

   Choices:
     * Passwords use scrypt from node:crypto — memory-hard, in the standard
       library, no dependency, and no native build step.
     * Session and Studio tokens are random 32 bytes; only their SHA-256 is
       stored, so a database dump yields no usable token.
     * Provider credentials use AES-256-GCM. GCM is authenticated: a modified
       ciphertext fails to decrypt rather than yielding attacker-chosen bytes.

   Nothing in this file logs, and no function returns a plaintext where a
   caller might accidentally persist it.
   ========================================================================== */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/* scrypt parameters. N=2^15 with r=8,p=1 is roughly 32 MB per hash: strong
   against GPU attack while staying fast enough for a login endpoint. */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

export interface PasswordHash {
  /** Stored as `scrypt$N$r$p$salt$hash`, all hex where applicable. */
  encoded: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant-time verification. A malformed stored hash simply fails. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N > 1048576 || r > 32 || p > 8) return false; // refuse absurd parameters

  const saltHex = parts[4] ?? '';
  const hashHex = parts[5] ?? '';
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LEN) return false;

  const actual = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 128 * N * r * 2),
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A URL-safe opaque token (unhashed — hand it to the client, store the hash). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Stable hash used to look a token up without storing it. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison for token checks. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* --------------------------------------------------------------------------
   Authenticated encryption for provider credentials at rest.
   -------------------------------------------------------------------------- */

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

const IV_LEN = 12; // 96-bit nonce, the GCM standard length

export class EnvelopeCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
    this.key = key;
  }

  /**
   * Seal a secret. `associatedData` binds the ciphertext to its owner, so a
   * row copied to another user's id fails authentication instead of
   * decrypting.
   */
  seal(plaintext: string, associatedData: string): Sealed {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  open(sealed: Sealed, associatedData: string): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, sealed.iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

/**
 * A short, non-reversible fingerprint of a key, for display only
 * ("sk-…f3a1"). It is a hash prefix, not the key, and cannot be reversed.
 */
export function keyHint(secret: string): string {
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 4);
  const prefix = secret.slice(0, 3).replace(/[^A-Za-z0-9_-]/g, '');
  return prefix ? `${prefix}…${fingerprint}` : `…${fingerprint}`;
}
