/* ==========================================================================
   BuildMind API — tests/studio.test.ts
   The Studio bridge protocol: session authentication, message allowlisting,
   replay protection, clock-skew rejection, ownership checks, and the
   ordering rule that validation can only be reported after delivery.

   The last section asserts the honesty property directly: a build that was
   never delivered to Studio must report `studioValidation: 'not_run'`, not
   `'passed'`.
   ========================================================================== */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { FakeOpenAI } from './helpers/fakeOpenAI.js';

let db: TestDb;
let testApp: TestApp;
let client: TestClient;
let userId: string;
const fake = new FakeOpenAI();

before(async () => {
  await fake.start();
  db = await createTestDb();
  testApp = await createTestApp({ databaseUrl: db.url, envOverrides: { OPENAI_BASE_URL: fake.url } });
});

after(async () => {
  await testApp.close();
  await db.drop();
  await fake.stop();
});

beforeEach(async () => {
  client = new TestClient(testApp.app);
  const registered = await client.register();
  userId = registered.user.id;
});

afterEach(async () => {
  fake.reset();
  await resetData(db.pool);
});

/** Register a Studio session and return its token. */
async function studioSession(): Promise<string> {
  const res = await client.post('/api/v1/studio/session');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.token as string;
}

/** A well-formed message envelope. */
function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    sessionId: randomUUID(),
    buildId: randomUUID(),
    runId: randomUUID(),
    messageType: 'hello',
    payload: {},
    timestamp: Date.now(),
    nonce: randomUUID(),
    ...overrides,
  };
}

async function postMessage(token: string, body: unknown) {
  return testApp.app.inject({
    method: 'POST',
    url: '/api/v1/studio/message',
    headers: { 'x-studio-token': token, 'content-type': 'application/json' },
    payload: body as object,
  });
}

describe('session authentication', () => {
  it('issues a token exactly once and stores only its hash', async () => {
    const token = await studioSession();
    assert.ok(token.length > 20);

    const rows = await db.pool.query<{ token_hash: string }>('SELECT token_hash FROM studio_sessions');
    assert.equal(rows.rowCount, 1);
    assert.ok(!rows.rows[0]?.token_hash.includes(token), 'the raw token must not be stored');
    assert.match(String(rows.rows[0]?.token_hash), /^[0-9a-f]{64}$/);
  });

  it('rejects a message with no token', async () => {
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/studio/message',
      payload: message(),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'STUDIO_UNAUTHORIZED');
  });

  it('rejects an unknown token', async () => {
    const res = await postMessage('not-a-real-token', message());
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_UNAUTHORIZED');
  });

  it('rejects a revoked session', async () => {
    const token = await studioSession();
    const sessions = await client.get('/api/v1/studio/status');
    assert.equal(sessions.status, 200);

    const row = await db.pool.query<{ id: string }>('SELECT id FROM studio_sessions LIMIT 1');
    const sessionId = row.rows[0]?.id ?? '';
    const revoked = await client.delete(`/api/v1/studio/session/${sessionId}`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.revoked, true);

    const res = await postMessage(token, message());
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_UNAUTHORIZED');
  });

  it('rejects an expired session', async () => {
    const token = await studioSession();
    await db.pool.query(`UPDATE studio_sessions SET expires_at = now() - interval '1 minute'`);

    const res = await postMessage(token, message());
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_UNAUTHORIZED');
  });
});

describe('protocol validation', () => {
  it('rejects a message with the wrong protocol version', async () => {
    const token = await studioSession();
    const res = await postMessage(token, message({ protocolVersion: 2 }));
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_PROTOCOL_ERROR');
  });

  it('rejects an unknown messageType', async () => {
    const token = await studioSession();
    const res = await postMessage(token, message({ messageType: 'run_arbitrary_code' }));
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_PROTOCOL_ERROR');
  });

  it('rejects a missing required field', async () => {
    const token = await studioSession();
    const incomplete = message();
    delete incomplete.nonce;
    const res = await postMessage(token, incomplete);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_PROTOCOL_ERROR');
  });

  it('rejects a message whose sessionId does not match the token', async () => {
    const token = await studioSession();
    const res = await postMessage(token, message({ sessionId: randomUUID() }));
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_UNAUTHORIZED');
  });

  it('rejects a timestamp outside the accepted window', async () => {
    const token = await studioSession();
    // The sessionId must match the session the token belongs to, otherwise the
    // session check rejects the message before the clock check is reached.
    const sessionId = (await db.pool.query<{ id: string }>('SELECT id FROM studio_sessions LIMIT 1')).rows[0]?.id ?? '';

    const stale = await postMessage(
      token,
      message({ sessionId, timestamp: Date.now() - 10 * 60 * 1000, nonce: randomUUID() }),
    );
    assert.equal(JSON.parse(stale.body).error.code, 'STUDIO_PROTOCOL_ERROR');

    const future = await postMessage(
      token,
      message({ sessionId, timestamp: Date.now() + 10 * 60 * 1000, nonce: randomUUID() }),
    );
    assert.equal(JSON.parse(future.body).error.code, 'STUDIO_PROTOCOL_ERROR');
  });

  it('rejects a replayed nonce', async () => {
    const token = await studioSession();
    const sessionId = (await db.pool.query<{ id: string }>('SELECT id FROM studio_sessions LIMIT 1')).rows[0]?.id ?? '';
    const nonce = randomUUID();
    const buildId = randomUUID();
    const runId = randomUUID();

    // First message: legal envelope (ownership will fail, but the nonce is claimed).
    const first = message({ sessionId, buildId, runId, nonce });
    await postMessage(token, first);

    // Second identical envelope: the nonce is spent.
    const second = await postMessage(token, first);
    assert.equal(JSON.parse(second.body).error.code, 'STUDIO_PROTOCOL_ERROR');
  });
});

describe('authorisation and ordering', () => {
  it('rejects a message about a build the user does not own', async () => {
    const token = await studioSession();
    const sessionId = (await db.pool.query<{ id: string }>('SELECT id FROM studio_sessions LIMIT 1')).rows[0]?.id ?? '';

    const res = await postMessage(token, message({ sessionId, buildId: randomUUID() }));
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_UNAUTHORIZED');
  });

  it('rejects validation reported before delivery', async () => {
    const token = await studioSession();
    const sessionId = (await db.pool.query<{ id: string }>('SELECT id FROM studio_sessions LIMIT 1')).rows[0]?.id ?? '';

    // Create a real project + build so ownership passes.
    const project = await client.post('/api/v1/projects', { name: 'Studio project' });
    const projectId = project.body.data.project.id;
    const build = await db.pool.query<{ id: string; run_id: string }>(
      `INSERT INTO builds (project_id, user_id, run_id, provider, model)
       VALUES ($1, $2, gen_random_uuid(), 'openai', 'gpt-4.1-mini') RETURNING id, run_id`,
      [projectId, userId],
    );
    const buildId = build.rows[0]?.id ?? '';
    const runId = build.rows[0]?.run_id ?? '';

    const res = await postMessage(
      token,
      message({ sessionId, buildId, runId, messageType: 'validation_complete', nonce: randomUUID() }),
    );
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'STUDIO_PROTOCOL_ERROR');
  });

  it('accepts a delivery followed by validation, and records Studio evidence separately', async () => {
    const token = await studioSession();
    const sessionId = (await db.pool.query<{ id: string }>('SELECT id FROM studio_sessions LIMIT 1')).rows[0]?.id ?? '';

    const project = await client.post('/api/v1/projects', { name: 'Studio project' });
    const projectId = project.body.data.project.id;
    const build = await db.pool.query<{ id: string; run_id: string }>(
      `INSERT INTO builds (project_id, user_id, run_id, provider, model)
       VALUES ($1, $2, gen_random_uuid(), 'openai', 'gpt-4.1-mini') RETURNING id, run_id`,
      [projectId, userId],
    );
    const buildId = build.rows[0]?.id ?? '';
    const runId = build.rows[0]?.run_id ?? '';

    const delivered = await postMessage(
      token,
      message({ sessionId, buildId, runId, messageType: 'delivery_complete', nonce: randomUUID() }),
    );
    assert.equal(JSON.parse(delivered.body).ok, true);

    const validated = await postMessage(
      token,
      message({ sessionId, buildId, runId, messageType: 'validation_complete', nonce: randomUUID() }),
    );
    assert.equal(JSON.parse(validated.body).ok, true);

    // Studio evidence is its own field, not merged into backend validation.
    const evidence = testApp.ctx.studio.studioValidationFor(buildId, runId);
    assert.equal(evidence, 'passed');
  });
});

describe('honesty of Studio status', () => {
  it('reports not_run when no plugin ever reported', async () => {
    const project = await client.post('/api/v1/projects', { name: 'No studio' });
    const projectId = project.body.data.project.id;
    const build = await db.pool.query<{ id: string; run_id: string }>(
      `INSERT INTO builds (project_id, user_id, run_id, provider, model)
       VALUES ($1, $2, gen_random_uuid(), 'openai', 'gpt-4.1-mini') RETURNING id, run_id`,
      [projectId, userId],
    );
    const buildId = build.rows[0]?.id ?? '';
    const runId = build.rows[0]?.run_id ?? '';

    assert.equal(
      testApp.ctx.studio.studioValidationFor(buildId, runId),
      'not_run',
      'absence of a Studio report must never read as success',
    );
  });

  it('refuses to deliver a build that is not complete', async () => {
    const project = await client.post('/api/v1/projects', { name: 'Incomplete' });
    const projectId = project.body.data.project.id;
    const build = await db.pool.query<{ id: string; run_id: string }>(
      `INSERT INTO builds (project_id, user_id, run_id, provider, model, status)
       VALUES ($1, $2, gen_random_uuid(), 'openai', 'gpt-4.1-mini', 'building') RETURNING id, run_id`,
      [projectId, userId],
    );

    const res = await client.post('/api/v1/studio/deliver', {
      buildId: build.rows[0]?.id,
      runId: build.rows[0]?.run_id,
    });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'VALIDATION_INCOMPLETE');
  });

  it('reports the session as inactive with no connected plugin', async () => {
    const status = await client.get('/api/v1/studio/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.sessionActive, false);
  });
});
