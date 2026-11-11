/* ==========================================================================
   BuildMind API — tests/authorization.test.ts
   Ownership enforcement. Every case here is an IDOR attempt, written the way
   a real attacker would try it: change the id, keep the session.

   The expected answer for someone else's resource is 404, not 403 — the
   service must not confirm that a private resource exists.
   ========================================================================== */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';

let db: TestDb;
let testApp: TestApp;

before(async () => {
  db = await createTestDb();
  testApp = await createTestApp({ databaseUrl: db.url });
});

after(async () => {
  await testApp.close();
  await db.drop();
});

afterEach(async () => {
  await resetData(db.pool);
});

async function twoUsers() {
  const alice = new TestClient(testApp.app);
  await alice.register('alice@example.com', 'correct-horse-battery');
  const bob = new TestClient(testApp.app);
  await bob.register('bob@example.com', 'correct-horse-battery');

  const created = await alice.post('/api/v1/projects', { name: "Alice's game", description: 'private' });
  assert.equal(created.status, 201);
  return { alice, bob, project: created.body.data.project as { id: string } };
}

describe('project ownership', () => {
  it('returns 404 when another user requests a project by id', async () => {
    const { bob, project } = await twoUsers();
    const res = await bob.get(`/api/v1/projects/${project.id}`);

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    // The message must not differ from a genuinely missing id.
    const missing = await bob.get('/api/v1/projects/00000000-0000-4000-8000-000000000000');
    assert.deepEqual(res.body.error, missing.body.error);
  });

  it('never lists another user\'s projects', async () => {
    const { bob } = await twoUsers();
    const res = await bob.get('/api/v1/projects');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.projects, []);
  });

  it('refuses to update another user\'s project', async () => {
    const { bob, project } = await twoUsers();
    const res = await bob.patch(`/api/v1/projects/${project.id}`, { name: 'hijacked' });

    assert.equal(res.status, 404);
    // Prove nothing changed.
    const row = await db.pool.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [project.id]);
    assert.equal(row.rows[0]?.name, "Alice's game");
  });

  it('refuses to delete another user\'s project', async () => {
    const { bob, project } = await twoUsers();
    const res = await bob.delete(`/api/v1/projects/${project.id}`);

    assert.equal(res.status, 404);
    const row = await db.pool.query('SELECT 1 FROM projects WHERE id = $1', [project.id]);
    assert.equal(row.rowCount, 1, 'the project must survive a foreign delete');
  });

  it('ignores a userId supplied in the body', async () => {
    const { bob } = await twoUsers();
    const res = await bob.post('/api/v1/projects', {
      name: 'attempt',
      userId: '00000000-0000-4000-8000-000000000000',
    });

    // `.strict()` rejects the extra field, so the attempted override fails
    // outright rather than being silently ignored.
    assert.equal(res.status, 422);
  });
});

describe('build ownership', () => {
  it('hides another user\'s build and its events', async () => {
    const { alice, bob, project } = await twoUsers();

    // Give alice a build that fails immediately for lack of a provider key is
    // not possible; instead create the row the way a build would exist.
    const build = await db.pool.query<{ id: string }>(
      `INSERT INTO builds (project_id, user_id, run_id, provider, model)
       VALUES ($1, (SELECT user_id FROM projects WHERE id = $1), gen_random_uuid(), 'openai', 'gpt-4.1-mini')
       RETURNING id`,
      [project.id],
    );
    const buildId = build.rows[0]?.id ?? '';
    assert.ok(buildId);

    const asBob = await bob.get(`/api/v1/builds/${buildId}`);
    assert.equal(asBob.status, 404);

    const events = await bob.get(`/api/v1/builds/${buildId}/events`);
    assert.equal(events.status, 404);

    const cancel = await bob.post(`/api/v1/builds/${buildId}/cancel`);
    assert.equal(cancel.status, 404);

    const retry = await bob.post(`/api/v1/builds/${buildId}/retry`);
    assert.equal(retry.status, 404);

    // Alice still sees her own build.
    const asAlice = await alice.get(`/api/v1/builds/${buildId}`);
    assert.equal(asAlice.status, 200);
  });
});

describe('cross-user isolation of stored credentials', () => {
  it('does not share a BYOK credential between accounts', async () => {
    const alice = new TestClient(testApp.app);
    await alice.register('cred-a@example.com', 'correct-horse-battery');
    const bob = new TestClient(testApp.app);
    await bob.register('cred-b@example.com', 'correct-horse-battery');

    // Store a key for alice directly through the service layer.
    await testApp.ctx.credentials.store(
      (await testApp.ctx.auth.resolve(alice.cookieHeader.split('=')[1] ?? ''))!.user.id,
      'openai',
      'sk-test-alice-key-1234567890',
    );

    const bobList = await bob.get('/api/v1/ai/providers');
    assert.equal(bobList.status, 200);
    assert.deepEqual(bobList.body.data.credentials, [], 'bob must see no credentials');
  });
});
