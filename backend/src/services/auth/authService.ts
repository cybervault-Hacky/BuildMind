/* ==========================================================================
   BuildMind API — services/auth/authService.ts
   Registration, login, logout and session resolution.

   Design notes:

     * Login does the same work for an unknown email as for a wrong password
       (a scrypt verification against a dummy hash), so response timing does
       not reveal whether an account exists.
     * Registration reports a duplicate as CONFLICT with generic copy. The
       registration form necessarily reveals account existence; login does not.
     * The raw session token is returned once, to be set as a cookie. Only its
       SHA-256 is stored.
   ========================================================================== */

import { AppError } from '../../errors/AppError.js';
import { generateToken, hashPassword, hashToken, verifyPassword } from '../../security/crypto.js';
import { UserRepository, toPublicUser, type PublicUser, type User } from '../../repositories/users/userRepository.js';
import { SessionRepository } from '../../repositories/sessions/sessionRepository.js';
import { SESSION_TTL_MS } from '../../config/constants.js';
import type { Queryable } from '../../db/pool.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  user: PublicUser;
}

export interface SessionContext {
  user: User;
  sessionId: string;
}

/**
 * A constant dummy hash so an unknown-email login costs the same time as a
 * wrong-password login. Generated once at module load.
 */
const DUMMY_HASH_PLACEHOLDER = 'scrypt$32768$8$1$00000000000000000000000000000000$' + '0'.repeat(64);

export class AuthService {
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private dummyHashPromise: Promise<string> | null = null;

  constructor(db: Queryable) {
    this.users = new UserRepository(db);
    this.sessions = new SessionRepository(db);
  }

  private async dummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      // Hash a random string once; the value is irrelevant, only its shape is.
      this.dummyHashPromise = hashPassword(`dummy-${generateToken()}`);
    }
    return this.dummyHashPromise;
  }

  async register(input: { email: string; password: string; displayName?: string }): Promise<IssuedSession> {
    const passwordHash = await hashPassword(input.password);
    const displayName = input.displayName?.trim() || input.email.split('@')[0] || 'Builder';

    const user = await this.users.create({ email: input.email, displayName, passwordHash });
    if (!user) {
      // The unique index rejected it: the email is taken.
      throw new AppError('CONFLICT', { fields: { email: 'That email is already registered.' } });
    }

    return this.issue(user);
  }

  async login(input: { email: string; password: string }): Promise<IssuedSession> {
    const user = await this.users.findByEmail(input.email);
    const hash = user ? user.passwordHash : await this.dummyHash();
    const matches = await verifyPassword(input.password, hash);

    if (!user || !matches) {
      // One message for both cases: no account enumeration through login.
      throw new AppError('UNAUTHENTICATED', { fields: { form: 'Email or password is incorrect.' } });
    }

    return this.issue(user);
  }

  private async issue(user: User): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sessions.create({ userId: user.id, tokenHash: hashToken(token), expiresAt });
    return { token, expiresAt, user: toPublicUser(user) };
  }

  /** Resolve a cookie token to a session, or null. Touches last_seen_at. */
  async resolve(token: string | undefined): Promise<SessionContext | null> {
    if (!token) return null;
    const session = await this.sessions.findValidByTokenHash(hashToken(token));
    if (!session) return null;

    const user = await this.users.findById(session.userId);
    if (!user) {
      // Session outlived its user (deleted account): revoke and refuse.
      await this.sessions.revoke(session.id);
      return null;
    }

    await this.sessions.touch(session.id);
    return { user, sessionId: session.id };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const session = await this.sessions.findValidByTokenHash(hashToken(token));
    if (session) await this.sessions.revoke(session.id);
  }

  /** Cleanup: remove sessions that expired long ago. */
  async pruneExpired(before: Date): Promise<number> {
    return this.sessions.deleteExpired(before);
  }

  /** Exposed for tests: a hash that will never match a real password. */
  static get placeholderHash(): string {
    return DUMMY_HASH_PLACEHOLDER;
  }
}
