/* ==========================================================================
   BuildMind API — tests/helpers/db.ts
   Test database provisioning.

   Each test file gets its own PostgreSQL *schema* in a shared database, so
   files can run independently and in sequence without dropping each other's
   tables. The search_path is set on every connection string, which keeps the
   isolation invisible to repositories.

   Requires TEST_DATABASE_URL to point at a real PostgreSQL server.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { up } from '../../src/db/migrate.js';

const { Pool } = pg;

export interface TestDb {
  /** Connection string pinned to this suite's schema. */
  url: string;
  schema: string;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

export function baseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL (or DATABASE_URL) must point at a PostgreSQL server');
  }
  return url;
}

export async function createTestDb(): Promise<TestDb> {
  const schema = `bm_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Pool({ connectionString: baseUrl() });

  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const separator = baseUrl().includes('?') ? '&' : '?';
  const url = `${baseUrl()}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

  // Migrations run inside the new schema, so each suite starts from the real
  // forward migrations rather than from a duplicate schema definition.
  await up(url);

  const pool = new Pool({ connectionString: url });

  return {
    url,
    schema,
    pool,
    drop: async () => {
      await pool.end();
      const cleanup = new Pool({ connectionString: baseUrl() });
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}

/** Truncate every table between tests without recreating the schema. */
export async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE users, sessions, projects, builds, build_events,
              provider_credentials, roblox_accounts, studio_sessions
     RESTART IDENTITY CASCADE`,
  );
}
