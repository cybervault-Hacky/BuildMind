/* ==========================================================================
   BuildMind API — tests/security.test.ts
   Input validation, CSRF, rate limiting, payload limits, path traversal,
   XSS payload handling, and error-message hygiene.
   ========================================================================== */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { FakeOpenAI } from './helpers/fakeOpenAI.js';
import { safeJoin, validateArtifacts } from '../src/services/builds/artifactService.js';
import { scrub } from '../src/utils/logger.js';

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

describe('CSRF', () => {
  it('refuses a state change without a CSRF token', async () => {
    // A client that never received a token.
    const bare = new TestClient(testApp.app);
    await bare.register('csrf@example.com', 'correct-horse-battery');

    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: bare.cookieHeader }, // session, but no x-csrf-token
      payload: { name: 'forged' },
    });

    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  it('refuses a wrong CSRF token', async () => {
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: client.cookieHeader, 'x-csrf-token': 'wrong-token-value' },
      payload: { name: 'forged' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('allows GET without a CSRF token', async () => {
    const res = await client.get('/api/v1/projects');
    assert.equal(res.status, 200);
  });
});

describe('input validation', () => {
  it('rejects malformed JSON with a safe error', async () => {
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: client.cookieHeader, 'content-type': 'application/json', 'x-csrf-token': 'x' },
      payload: '{"name": ',
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    // The parser's own message (which can echo input) must not be relayed.
    assert.ok(!res.body.includes('Unexpected end of JSON'));
  });

  it('rejects an oversized body', async () => {
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: client.cookieHeader, 'x-csrf-token': 'x', 'content-type': 'application/json' },
      payload: { name: 'x', description: 'y'.repeat(400 * 1024) },
    });
    assert.equal(res.statusCode, 413);
  });

  it('rejects a malformed id in the path', async () => {
    const res = await client.get('/api/v1/projects/not-a-uuid');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an oversized prompt', async () => {
    const project = await client.post('/api/v1/projects', { name: 'P' });
    const res = await client.post('/api/v1/builds', {
      projectId: project.body.data.project.id,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'x'.repeat(5000),
      apiKey: 'sk-test-key-1234567890',
    });
    assert.equal(res.status, 422);
  });

  it('rejects an unknown enum value', async () => {
    const res = await client.get('/api/v1/projects?status=not-a-status');
    assert.equal(res.status, 422);
  });

  it('rejects a negative or absurd limit', async () => {
    assert.equal((await client.get('/api/v1/projects?limit=-1')).status, 422);
    assert.equal((await client.get('/api/v1/projects?limit=100000')).status, 422);
  });

  it('treats an XSS payload as inert data, not markup', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const created = await client.post('/api/v1/projects', { name: payload });
    assert.equal(created.status, 201);

    // Stored verbatim as text — escaping is the renderer's job, and the API
    // returns JSON (content-type application/json), so a browser will not
    // parse it as HTML here.
    const read = await client.get(`/api/v1/projects/${created.body.data.project.id}`);
    assert.equal(read.body.data.project.name, payload);
    assert.match(String(read.headers['content-type']), /application\/json/);
    assert.equal(read.headers['x-content-type-options'], 'nosniff');
  });
});

describe('path traversal', () => {
  const hostile = [
    '../../../etc/passwd',
    '..\\..\\windows\\system32',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'scripts/../../escape.luau',
    'null\0byte.luau',
    'a//b.luau',
  ];

  for (const path of hostile) {
    it(`rejects artifact path ${JSON.stringify(path)}`, () => {
      const result = validateArtifacts([{ path, type: 'script', content: 'x', metadata: {} }]);
      assert.equal(result.valid, false, `path should be rejected: ${path}`);
      assert.ok(result.issues.length > 0);
      assert.equal(result.artifacts.length, 0);
    });
  }

  it('safeJoin refuses to escape the workspace root', () => {
    const root = '/tmp/bm-workspace-root';
    assert.throws(() => safeJoin(root, '../../etc/passwd'));
    assert.throws(() => safeJoin(root, '/etc/passwd'));
    // A legitimate nested path resolves inside the root.
    const inside = safeJoin(root, 'scripts/Main.luau');
    assert.ok(inside.startsWith(root));
  });
});

describe('error message hygiene', () => {
  it('never returns a stack, SQL or a file path', async () => {
    const res = await client.get('/api/v1/projects/00000000-0000-4000-8000-000000000000');
    const text = JSON.stringify(res.body);

    assert.equal(res.status, 404);
    for (const leak of ['    at ', 'SELECT ', 'FROM projects', 'node_modules', '/home/', 'postgres://', 'Error:']) {
      assert.ok(!text.includes(leak), `error leaked: ${leak}`);
    }
  });

  it('does not echo a submitted oversized field back to the caller', async () => {
    const marker = 'LEAKMARKER';
    // A real CSRF token, so the request reaches validation: this asserts that
    // the CSRF guard runs first and validation second, in that order.
    const me = await client.get('/api/v1/auth/me');
    const token = String(me.body.data.csrfToken);
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: client.cookieHeader, 'x-csrf-token': token, 'content-type': 'application/json' },
      payload: { name: marker.repeat(3000) },
    });

    assert.equal(res.statusCode, 422);
    assert.ok(!res.body.includes(marker), 'the response must not echo the submitted value');
  });
});

describe('log scrubbing', () => {
  it('redacts credential-shaped strings anywhere in a log record', () => {
    const record = {
      event: 'test',
      message: 'key sk-abcdefghijklmnopqrstuvwxyz012345 and AIzaSyA1234567890abcdefghijklmnopqrstu',
      nested: { authorization: 'Bearer abcdefghijklmnop', password: 'hunter2' },
      list: ['sk-proj-aaaaaaaaaaaaaaaaaaaa'],
    };

    const scrubbed = JSON.stringify(scrub(record));
    assert.ok(!scrubbed.includes('sk-abc'), 'openai-style key must be redacted');
    assert.ok(!scrubbed.includes('AIzaSy'), 'google-style key must be redacted');
    assert.ok(!scrubbed.includes('hunter2'), 'password field must be redacted');
    assert.ok(!scrubbed.includes('Bearer abcdef'), 'authorization must be redacted');
    assert.ok(!scrubbed.includes('sk-proj-aaaa'), 'nested list key must be redacted');
  });
});

describe('rate limiting', () => {
  it('engages on real HTTP and returns a safe RATE_LIMITED error', async () => {
    // fastify.inject() reuses one synthetic IP and drains the bucket for the
    // whole suite, so the limiter is verified over a real socket instead.
    const { createServer } = await import('node:http');
    const listen = await testApp.app.listen({ port: 0, host: '127.0.0.1' });
    const address = new URL(listen);

    try {
      const statuses: number[] = [];
      let limitedBody: unknown = null;

      for (let i = 0; i < 340; i += 1) {
        const res = await fetch(`${address}api/v1/health`);
        statuses.push(res.status);
        if (res.status === 429) {
          limitedBody = await res.json();
          break;
        }
      }

      assert.ok(statuses.includes(429), `expected a 429 within 340 requests, saw ${statuses.length}`);

      const body = limitedBody as { ok: boolean; error: { code: string; message: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'RATE_LIMITED');
      // The message must not reveal the bucket size or internal state.
      assert.ok(!/\d{2,}/.test(body.error.message.replace('shortly', '')));
    } finally {
      await new Promise<void>((resolve) => createServer().close(() => resolve()));
      await testApp.app.close();
    }
  });
});
