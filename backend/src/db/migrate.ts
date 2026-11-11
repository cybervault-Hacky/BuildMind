/* ==========================================================================
   BuildMind API — db/migrate.ts
   A real, ordered migration runner.

   Migrations are plain .sql files in backend/migrations, applied in filename
   order inside a transaction and recorded in schema_migrations. Re-running is
   a no-op. `down` reverses the most recent applied migration, which exists so
   a bad deploy can be rolled back — it is not an everyday command.

   Usage:  npm run migrate           (apply all pending)
           npm run migrate:down      (reverse the last applied)
   ========================================================================== */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

const { Client } = pg;

interface MigrationFile {
  name: string;
  sql: string;
}

async function readMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  // `*.down.sql` files reverse a migration; they are never applied forward.
  const files = entries.filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql')).sort();
  const out: MigrationFile[] = [];
  for (const name of files) {
    out.push({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') });
  }
  return out;
}

async function ensureTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function applied(client: pg.Client): Promise<Set<string>> {
  const res = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(res.rows.map((r) => r.name));
}

/** Apply every pending migration in order. Returns the names applied. */
export async function up(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const done: string[] = [];
  try {
    await ensureTable(client);
    const already = await applied(client);
    for (const migration of await readMigrations()) {
      if (already.has(migration.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        done.push(migration.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return done;
}

/**
 * Reverse the most recently applied migration.
 *
 * A migration is reversible when it ships a matching `<name>.down.sql`. Rather
 * than inventing destructive SQL at rollback time, we require the down script
 * to exist — an operator who wrote the migration knows how to undo it.
 */
export async function down(connectionString: string): Promise<string | null> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensureTable(client);
    const res = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1',
    );
    const last = res.rows[0];
    if (!last) return null;

    const downSql = await readFile(join(MIGRATIONS_DIR, `${last.name.replace(/\.sql$/, '')}.down.sql`), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(downSql);
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [last.name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return last.name;
  } finally {
    await client.end();
  }
}

/* CLI entry point. */
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  try {
    if (direction === 'up') {
      const done = await up(connectionString);
      console.log(done.length ? `applied: ${done.join(', ')}` : 'already up to date');
    } else {
      const name = await down(connectionString);
      console.log(name ? `reversed: ${name}` : 'nothing to reverse');
    }
  } catch (err) {
    console.error('migration failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
