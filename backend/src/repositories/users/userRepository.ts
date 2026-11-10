/* ==========================================================================
   BuildMind API — repositories/users/userRepository.ts
   All SQL for users. Returns domain objects, never raw rows with surprises.

   `passwordHash` is part of the domain object because the auth service needs
   it, but no service may return a User to a client — the auth controller maps
   to a `PublicUser` explicitly (see toPublicUser).
   ========================================================================== */

import type { Queryable } from '../../db/pool.js';

export interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

/** Explicit projection: the only way a user crosses to a client. */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}

export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `SELECT id, email, display_name, password_hash, created_at
         FROM users WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `SELECT id, email, display_name, password_hash, created_at
         FROM users WHERE email_lower = lower($1)`,
      [email],
    );
    const row = res.rows[0];
    return row ? toUser(row) : null;
  }

  /**
   * Insert a user. Returns null when the email already exists — the unique
   * index is the authority, not a prior SELECT, so two simultaneous
   * registrations cannot both succeed.
   */
  async create(input: { email: string; displayName: string; passwordHash: string }): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `INSERT INTO users (email, display_name, password_hash)
            VALUES ($1, $2, $3)
       ON CONFLICT (email_lower) DO NOTHING
         RETURNING id, email, display_name, password_hash, created_at`,
      [input.email, input.displayName, input.passwordHash],
    );
    const row = res.rows[0];
    return row ? toUser(row) : null;
  }
}
