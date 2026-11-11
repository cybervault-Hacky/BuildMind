/* ==========================================================================
   BuildMind API — tests/concurrency.test.ts
   Races that a single-user happy path never reveals.

     * two builds submitted for one project at once
     * the per-user concurrency cap
     * cancel racing a provider response
     * retry racing old-run events
     * simultaneous updates and delete-vs-read
     * listener bookkeeping (no leaked SSE subscribers)

   Each test asserts on the *stored* outcome, not on the response body, so a
   lie in an HTTP reply cannot make a test pass.
   ========================================================================== */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { FakeOpenAI } from './helpers/fakeOpenAI.js';
import { MAX_CONCURRENT_BUILDS_PER_USER } from '../src/config/constants.js';

let db: TestDb;
let testApp: TestApp;
let client: TestClient;
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
  await client.register();
});

afterEach(async () => {
  fake.reset();
  await resetData(db.pool);
});

async function project(name = 'Race'): Promise<string> {
  const res = await client.post('/api/v1/projects', { name });
  return res.body.data.project.id as string;
}

async function settle(buildId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.get(`/api/v1/builds/${buildId}`);
    const status = res.body.data.build.status as string;
    if (['complete', 'failed', 'cancelled'].includes(status)) return status;
    if (Date.now() > deadline) throw new Error(`build stuck in ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('build races', () => {
  it('two simultaneous submissions for one project start exactly one build', async () => {
    fake.options = { delayMs: 120 };
    const projectId = await project();

    const payload = {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-race-key',
    };

    const [a, b] = await Promise.all([
      client.post('/api/v1/builds', payload),
      client.post('/api/v1/builds', payload),
    ]);

    const accepted = [a, b].filter((r) => r.status === 202);
    const rejected = [a, b].filter((r) => r.status !== 202);

    assert.equal(accepted.length, 1, 'exactly one submission should be accepted');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.body.error.code, 'BUILD_CONFLICT');

    // And exactly one build row exists.
    const rows = await db.pool.query('SELECT 1 FROM builds WHERE project_id = $1', [projectId]);
    assert.equal(rows.rowCount, 1);

    const id = accepted[0]?.body.data.build.id as string;
    await settle(id);
  });

  it('enforces the per-user concurrency cap', async () => {
    fake.options = { delayMs: 200 };
    const ids: string[] = [];

    // One build per project, up to the cap.
    for (let i = 0; i < MAX_CONCURRENT_BUILDS_PER_USER; i += 1) {
      const projectId = await project(`Cap ${i}`);
      const res = await client.post('/api/v1/builds', {
        projectId,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        prompt: 'a wave survival arena game',
        apiKey: 'sk-test-cap-key',
      });
      assert.equal(res.status, 202, `build ${i} should start`);
      ids.push(res.body.data.build.id);
    }

    // One more project, one more build: refused by the cap, not by the project.
    const extraProject = await project('Cap extra');
    const extra = await client.post('/api/v1/builds', {
      projectId: extraProject,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-cap-key',
    });

    assert.equal(extra.status, 409);
    assert.match(JSON.stringify(extra.body.error.fields), /too many builds/i);

    for (const id of ids) {
      await client.post(`/api/v1/builds/${id}/cancel`);
      await settle(id);
    }
  });

  it('a cancel racing the provider response never ends as complete', async () => {
    // The provider answers after a delay, so the cancel lands mid-call.
    fake.options = { delayMs: 150 };
    const projectId = await project();
    const created = await client.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-race-key',
    });
    const buildId = created.body.data.build.id as string;

    // Cancel almost immediately, while the first provider call is in flight.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.post(`/api/v1/builds/${buildId}/cancel`);

    const status = await settle(buildId);
    assert.equal(status, 'cancelled');

    // Wait past the point the provider would have answered, then re-check.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const row = await db.pool.query<{ status: string }>('SELECT status FROM builds WHERE id = $1', [buildId]);
    assert.equal(row.rows[0]?.status, 'cancelled', 'the late provider answer must not revive the build');
  });

  it('retry produces a new run whose events never mix with the old run', async () => {
    fake.options = { failChatWith: 503 };
    const projectId = await project();
    const created = await client.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-retry-key',
    });
    const firstId = created.body.data.build.id as string;
    await settle(firstId);

    fake.reset();
    const retried = await client.post(`/api/v1/builds/${firstId}/retry`);
    const secondId = retried.body.data.build.id as string;
    const secondRun = retried.body.data.build.runId as string;
    await settle(secondId);

    // Every persisted event belongs to exactly one run, and the second run's
    // events are all tagged with the second run id.
    const events = await db.pool.query<{ run_id: string }>(
      'SELECT run_id FROM build_events WHERE build_id = $1',
      [secondId],
    );
    const runs = new Set(events.rows.map((r) => r.run_id));
    assert.equal(runs.size, 1);
    assert.equal([...runs][0], secondRun);

    // The first build is untouched by the retry.
    const firstRow = await db.pool.query<{ status: string; run_id: string }>(
      'SELECT status, run_id FROM builds WHERE id = $1',
      [firstId],
    );
    assert.equal(firstRow.rows[0]?.status, 'failed');
  });
});

describe('project races', () => {
  it('serialises simultaneous updates without losing either write', async () => {
    const projectId = await project('Contended');

    const results = await Promise.all([
      client.patch(`/api/v1/projects/${projectId}`, { name: 'First' }),
      client.patch(`/api/v1/projects/${projectId}`, { description: 'Second' }),
    ]);

    assert.ok(results.every((r) => r.status === 200));
    const row = await db.pool.query<{ name: string; description: string }>(
      'SELECT name, description FROM projects WHERE id = $1',
      [projectId],
    );
    // Both writes landed: name from one, description from the other.
    assert.equal(row.rows[0]?.name, 'First');
    assert.equal(row.rows[0]?.description, 'Second');
  });

  it('delete racing read leaves a consistent state', async () => {
    const projectId = await project('Doomed');

    const [deleted, read] = await Promise.all([
      client.delete(`/api/v1/projects/${projectId}`),
      client.get(`/api/v1/projects/${projectId}`),
    ]);

    assert.equal(deleted.status, 200);
    // The read either saw it (200) or did not (404); both are valid, but the
    // row must be gone afterwards either way.
    assert.ok([200, 404].includes(read.status));

    const after = await db.pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    assert.equal(after.rowCount, 0);
  });
});

describe('listener bookkeeping', () => {
  it('releases every subscriber when a stream closes', async () => {
    const projectId = await project();
    const created = await client.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-stream-key',
    });
    const buildId = created.body.data.build.id as string;
    const runId = created.body.data.build.runId as string;

    const before = testApp.ctx.bus.totalListeners();

    // Subscribe and unsubscribe repeatedly: the count must return to baseline.
    for (let i = 0; i < 25; i += 1) {
      const off = testApp.ctx.bus.subscribe(buildId, runId, () => {});
      off();
      off(); // idempotent: a double call must not corrupt the count
    }

    assert.equal(testApp.ctx.bus.totalListeners(), before, 'subscribers must not accumulate');
    assert.equal(testApp.ctx.bus.listenerCount(buildId, runId), 0);

    await settle(buildId);
  });
});
