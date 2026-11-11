/* ==========================================================================
   BuildMind API — db/pool.ts
   One connection pool, one query helper, one transaction helper.

   Repositories receive a `Queryable` (either the pool or a transaction
   client), so the same repository code composes into transactions without
   knowing whether it is inside one.
   ========================================================================== */

import pg from 'pg';

const { Pool } = pg;

export type Queryable = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
};

export interface DbConfig {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
}

export function createPool(config: DbConfig): pg.Pool {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    // A bounded timeout means a stalled database surfaces as an error rather
    // than an indefinitely open request.
    statement_timeout: config.statementTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    // An idle client erroring is not fatal: pg replaces it. Log the fact, not
    // the connection string.
    console.error(JSON.stringify({ level: 'error', event: 'db.idle_client_error', message: err.message }));
  });

  return pool;
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}
