/* ==========================================================================
   BuildMind API — tests/api.test.ts
   Contract tests for the routes themselves: shapes, status codes, pagination,
   the SSE stream, health endpoints, and the AI provider surface.

   These assert the wire contract the frontend depends on, so a change in a
   controller that breaks the client fails here rather than in a browser.
   ========================================================================== */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { FakeOpenAI } from './helpers/fakeOpenAI.js';

let db: TestDb;
let testApp: TestApp;
let client: TestClient;
const fake = new FakeOpenAI();

before(async () => {
  await fake.start();
  db = await createTestDb();
  testApp = await createTestApp({
    databaseUrl: db.url,
    envOverrides: { OPENAI_BASE_URL: fake.url, GOOGLE_BASE_URL: fake.url },
  });
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

describe('envelope contract', () => {
  it('wraps success as { ok, data }', async () => {
    const res = await client.get('/api/v1/projects');
    assert.equal(res.body.ok, true);
    assert.ok('data' in res.body);
  });

  it('wraps failure as { ok, error: { code, message } }', async () => {
    const res = await client.get('/api/v1/projects/00000000-0000-4000-8000-000000000000');
    assert.equal(res.body.ok, false);
    assert.equal(typeof res.body.error.code, 'string');
    assert.equal(typeof res.body.error.message, 'string');
    assert.ok(!('stack' in res.body.error));
  });

  it('returns 404 for an unknown route with the same envelope', async () => {
    const res = await client.get('/api/v1/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('sets the API security headers on every response', async () => {
    const res = await client.get('/api/v1/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(res.headers['referrer-policy']), /no-referrer/);
  });
});

describe('health', () => {
  it('GET /health needs no auth and reveals nothing', async () => {
    const res = await testApp.app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { ok: true, data: { status: 'ok' } });
    // No version, no uptime, no config.
    assert.ok(!res.body.includes('postgres'));
    assert.ok(!res.body.includes('version'));
  });

  it('GET /ready confirms the database is reachable', async () => {
    const res = await testApp.app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.database, 'reachable');
  });
});

describe('projects', () => {
  it('creates, reads, updates and deletes', async () => {
    const created = await client.post('/api/v1/projects', { name: 'Alpha', description: 'first' });
    assert.equal(created.status, 201);
    const id = created.body.data.project.id as string;
    assert.equal(created.body.data.project.status, 'draft');

    const read = await client.get(`/api/v1/projects/${id}`);
    assert.equal(read.body.data.project.name, 'Alpha');

    const updated = await client.patch(`/api/v1/projects/${id}`, { name: 'Beta' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.project.name, 'Beta');

    const removed = await client.delete(`/api/v1/projects/${id}`);
    assert.equal(removed.status, 200);
    assert.equal((await client.get(`/api/v1/projects/${id}`)).status, 404);
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 5; i += 1) {
      await client.post('/api/v1/projects', { name: `Project ${i}` });
    }

    const first = await client.get('/api/v1/projects?limit=2');
    assert.equal(first.body.data.projects.length, 2);
    assert.ok(first.body.data.nextCursor, 'a cursor should be returned when more exist');

    const second = await client.get(`/api/v1/projects?limit=2&cursor=${first.body.data.nextCursor}`);
    assert.equal(second.body.data.projects.length, 2);
    // No overlap between pages.
    const firstIds = first.body.data.projects.map((p: { id: string }) => p.id);
    const secondIds = second.body.data.projects.map((p: { id: string }) => p.id);
    assert.equal(firstIds.filter((id: string) => secondIds.includes(id)).length, 0);
  });

  it('filters by status and searches by text', async () => {
    await client.post('/api/v1/projects', { name: 'Arena Builder', description: 'waves' });
    await client.post('/api/v1/projects', { name: 'Racing Game', description: 'cars' });

    const bySearch = await client.get('/api/v1/projects?q=arena');
    assert.equal(bySearch.body.data.projects.length, 1);
    assert.equal(bySearch.body.data.projects[0].name, 'Arena Builder');

    const byStatus = await client.get('/api/v1/projects?status=complete');
    assert.equal(byStatus.body.data.projects.length, 0);
  });

  it('rejects an empty update', async () => {
    const created = await client.post('/api/v1/projects', { name: 'Alpha' });
    const res = await client.patch(`/api/v1/projects/${created.body.data.project.id}`, {});
    assert.equal(res.status, 422);
  });

  it('never creates a project merely because the list was read', async () => {
    await client.get('/api/v1/projects');
    const rows = await db.pool.query('SELECT 1 FROM projects');
    assert.equal(rows.rowCount, 0, 'reading must not seed data');
  });
});

describe('AI provider surface', () => {
  it('lists providers with models and capability flags only', async () => {
    const res = await client.get('/api/v1/ai/providers');
    assert.equal(res.status, 200);

    const providers = res.body.data.providers as Array<Record<string, unknown>>;
    const ids = providers.map((p) => p.id);
    assert.deepEqual(ids.sort(), ['google', 'openai']);

    for (const provider of providers) {
      // No credential material of any kind.
      assert.ok(!('apiKey' in provider));
      assert.ok(!('managedKey' in provider));
      assert.ok(Array.isArray(provider.models));
      assert.equal(typeof provider.managedAvailable, 'boolean');
    }

    // The test-only provider is never exposed.
    assert.ok(!ids.includes('mock'));
  });

  it('lists models for one provider', async () => {
    const res = await client.get('/api/v1/ai/providers/openai/models');
    assert.equal(res.status, 200);
    const ids = res.body.data.models.map((m: { id: string }) => m.id);
    assert.ok(ids.includes('gpt-4.1-mini'));
    // A Google model must not appear under OpenAI.
    assert.ok(!ids.includes('gemini-2.5-flash'));
  });

  it('reports not_configured when no key is available', async () => {
    const res = await client.post('/api/v1/ai/validate', { provider: 'openai' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'not_configured');
    assert.equal(res.body.data.valid, false);
  });

  it('reports valid only after a real provider request succeeds', async () => {
    fake.reset();
    const res = await client.post('/api/v1/ai/validate', { provider: 'openai', apiKey: 'sk-test-valid-key' });

    assert.equal(res.body.data.status, 'valid');
    assert.equal(res.body.data.valid, true);
    // A real request happened.
    assert.ok(fake.requests.some((r) => r.path.endsWith('/models')));
  });

  it('reports invalid for a rejected key', async () => {
    fake.modelsStatus = 401;
    const res = await client.post('/api/v1/ai/validate', { provider: 'openai', apiKey: 'sk-test-bad-key' });
    assert.equal(res.body.data.status, 'invalid');
    assert.equal(res.body.data.valid, false);
  });

  it('rejects a model that does not belong to the provider', async () => {
    const res = await client.post('/api/v1/ai/validate', {
      provider: 'openai',
      model: 'gemini-2.5-pro',
      apiKey: 'sk-test-valid-key',
    });
    assert.equal(res.body.data.status, 'invalid');
  });

  it('rejects an unknown provider at the edge', async () => {
    const res = await client.post('/api/v1/ai/validate', { provider: 'not-a-provider', apiKey: 'sk-test-x' });
    assert.equal(res.status, 422);
  });
});

describe('build events over HTTP', () => {
  it('streams events as Server-Sent Events and terminates', async () => {
    const project = await client.post('/api/v1/projects', { name: 'Stream' });
    const created = await client.post('/api/v1/builds', {
      projectId: project.body.data.project.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-stream-key',
    });
    const buildId = created.body.data.build.id as string;

    // Listen once and leave it open: closing the shared instance would break
    // every later test in this file.
    const listen = await testApp.app.listen({ port: 0, host: '127.0.0.1' });
    {
      const response = await fetch(`${listen}/api/v1/builds/${buildId}/stream`, {
        headers: { cookie: client.cookieHeader },
      });

      assert.equal(response.status, 200);
      assert.match(String(response.headers.get('content-type')), /text\/event-stream/);

      const text = await response.text();
      assert.ok(text.includes('data:'), 'the stream should emit SSE frames');
      // Terminal frame present, with the final status.
      assert.match(text, /"terminal":true/);
      assert.match(text, /complete|failed|cancelled/);
    }
  });

  it('refuses to stream another user\'s build', async () => {
    const other = new TestClient(testApp.app);
    await other.register('nosy@example.com', 'correct-horse-battery');

    const project = await client.post('/api/v1/projects', { name: 'Private' });
    const created = await client.post('/api/v1/builds', {
      projectId: project.body.data.project.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: 'sk-test-stream-key',
    });

    const res = await other.get(`/api/v1/builds/${created.body.data.build.id}/stream`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

describe('CORS', () => {
  it('allows the configured origin', async () => {
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'http://localhost:8080' },
    });
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:8080');
  });

  it('does not echo an unconfigured origin', async () => {
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('never uses a wildcard origin', async () => {
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'http://localhost:8080' },
    });
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  });
});
