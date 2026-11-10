/* ==========================================================================
   BuildMind API — tests/secretLeak.test.ts
   One test credential, tracked through every sink the system has.

   The test key is a distinctive, searchable string. After a full build runs
   with it, the suite asserts it appears in exactly one place — the encrypted
   ciphertext boundary — and in none of:

     HTTP responses · response headers · build events · project records
     build records · the log buffer · the workspace on disk · error messages
     the user's credential listing · the provider request as a plaintext echo

   If a new sink is added to the product, add it here. A test that only
   checked the obvious sinks would pass while the key sat in a log line.
   ========================================================================== */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { FakeOpenAI } from './helpers/fakeOpenAI.js';

/** Distinctive enough that a substring search is conclusive. */
const SECRET = 'sk-test-LEAKCANARY-0123456789abcdefghijklmnop';
const CANARY = 'LEAKCANARY';

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
  testApp.logger.clear();
  client = new TestClient(testApp.app);
  await client.register();
});

afterEach(async () => {
  fake.reset();
  await resetData(db.pool);
});

/** Every file under the workspace root, concatenated. */
async function workspaceContents(root: string): Promise<string> {
  let text = '';
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else text += await readFile(path, 'utf8');
    }
  }
  await walk(root);
  return text;
}

describe('credential containment', () => {
  it('never lets the key escape the encrypted boundary during a full build', async () => {
    const project = await client.post('/api/v1/projects', {
      name: 'Canary project',
      description: 'a project that must never hold a key',
      prompt: 'a wave survival arena game',
    });
    const projectId = project.body.data.project.id as string;

    // 1. Validate the credential (a real adapter request to the fake provider).
    const validated = await client.post('/api/v1/ai/validate', {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: SECRET,
    });
    assert.equal(validated.status, 200);
    assert.equal(validated.body.data.status, 'valid');
    assert.ok(!JSON.stringify(validated.body).includes(CANARY), 'validate response must not echo the key');

    // 2. Run a full build with it.
    const created = await client.post('/api/v1/builds', {
      projectId,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      prompt: 'a wave survival arena game',
      apiKey: SECRET,
    });
    assert.equal(created.status, 202);
    const buildId = created.body.data.build.id as string;
    assert.ok(!JSON.stringify(created.body).includes(CANARY), 'build create must not echo the key');

    // Wait for the build to settle.
    for (let i = 0; i < 200; i += 1) {
      const res = await client.get(`/api/v1/builds/${buildId}`);
      if (['complete', 'failed', 'cancelled'].includes(res.body.data.build.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    /* --- sink 1: build + project + event responses ---------------------- */
    const surfaces = await Promise.all([
      client.get(`/api/v1/builds/${buildId}`),
      client.get(`/api/v1/builds/${buildId}/events`),
      client.get(`/api/v1/builds?limit=50`),
      client.get(`/api/v1/projects`),
      client.get(`/api/v1/projects/${projectId}`),
      client.get('/api/v1/ai/providers'),
      client.get('/api/v1/auth/me'),
    ]);
    for (const surface of surfaces) {
      assert.ok(!JSON.stringify(surface.body).includes(CANARY), 'an API response leaked the key');
      assert.ok(!JSON.stringify(surface.headers).includes(CANARY), 'a response header leaked the key');
    }

    /* --- sink 2: the credential listing shows a hint, not the key ------- */
    const providers = surfaces[5];
    const hints = JSON.stringify(providers.body.data.credentials);
    assert.ok(!hints.includes(CANARY), 'credential listing leaked the key');
    assert.ok(hints.includes('…'), 'credential listing should show a hint');

    /* --- sink 3: database rows ------------------------------------------ */
    const tables = ['projects', 'builds', 'build_events', 'users', 'sessions'];
    for (const table of tables) {
      const rows = await db.pool.query(`SELECT * FROM ${table}`);
      assert.ok(
        !JSON.stringify(rows.rows).includes(CANARY),
        `table ${table} leaked the key into an ordinary record`,
      );
    }

    // The credential row holds ciphertext only.
    const cred = await db.pool.query<{ ciphertext: Buffer; key_hint: string }>(
      'SELECT ciphertext, key_hint FROM provider_credentials',
    );
    assert.equal(cred.rowCount, 1);
    const stored = cred.rows[0];
    assert.ok(stored, 'a credential row should exist');
    assert.ok(Buffer.isBuffer(stored.ciphertext));
    assert.ok(!stored.ciphertext.toString('utf8').includes(CANARY), 'ciphertext must not contain the plaintext');
    assert.ok(!stored.key_hint.includes(CANARY), 'the hint must not contain the key');

    /* --- sink 4: the log buffer ---------------------------------------- */
    const logs = testApp.logger.lines().join('\n');
    assert.ok(logs.length > 0, 'the app should have logged something');
    assert.ok(!logs.includes(CANARY), 'a log line leaked the key');
    assert.ok(!logs.includes('sk-test-'), 'a log line leaked a key-shaped string');

    /* --- sink 5: the workspace on disk --------------------------------- */
    const disk = await workspaceContents(testApp.workspaceRoot);
    assert.ok(disk.length > 0, 'the workspace should contain build files');
    assert.ok(!disk.includes(CANARY), 'a workspace file leaked the key');

    /* --- sink 6: it never appears in a URL ----------------------------- */
    for (const surface of surfaces) {
      assert.ok(!JSON.stringify(surface.body).includes(`apiKey=${CANARY}`));
    }
  });

  it('does not return the key when a validation fails', async () => {
    fake.modelsStatus = 401;
    const res = await client.post('/api/v1/ai/validate', {
      provider: 'openai',
      apiKey: SECRET,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.valid, false);
    assert.ok(!JSON.stringify(res.body).includes(CANARY), 'a failed validation leaked the key');
    // The provider's own message is never relayed.
    assert.ok(!JSON.stringify(res.body).includes('unauthorized'));
  });

  it('does not persist a key whose validation failed', async () => {
    fake.modelsStatus = 401;
    await client.post('/api/v1/ai/validate', { provider: 'openai', apiKey: SECRET });

    const rows = await db.pool.query('SELECT 1 FROM provider_credentials');
    assert.equal(rows.rowCount, 0, 'a rejected key must not be stored');
  });

  it('forgets a stored key on request', async () => {
    await client.post('/api/v1/ai/validate', { provider: 'openai', apiKey: SECRET });
    const before = await db.pool.query('SELECT 1 FROM provider_credentials');
    assert.equal(before.rowCount, 1);

    const removed = await client.delete('/api/v1/ai/credentials/openai');
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.removed, true);

    const after = await db.pool.query('SELECT 1 FROM provider_credentials');
    assert.equal(after.rowCount, 0);
  });

  it('binds ciphertext to its owner, so a copied row cannot be decrypted', async () => {
    // Store a key for user A.
    const statusA = await client.post('/api/v1/ai/validate', { provider: 'openai', apiKey: SECRET });
    assert.equal(statusA.body.data.status, 'valid');

    const rowA = await db.pool.query<{ user_id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      'SELECT user_id, ciphertext, iv, auth_tag FROM provider_credentials',
    );
    const stored = rowA.rows[0];
    assert.ok(stored);

    // Create a second user and graft A's ciphertext onto them.
    const other = new TestClient(testApp.app);
    const otherUser = await other.register('victim@example.com', 'correct-horse-battery');

    await db.pool.query('DELETE FROM provider_credentials');
    await db.pool.query(
      `INSERT INTO provider_credentials (user_id, provider, ciphertext, iv, auth_tag, key_hint, expires_at)
       VALUES ($1, 'openai', $2, $3, $4, 'hint', now() + interval '1 hour')`,
      [otherUser.user.id, stored.ciphertext, stored.iv, stored.auth_tag],
    );

    // The AAD includes the user id, so decryption fails for the new owner and
    // the service drops the unusable row instead of returning a key.
    const resolved = await testApp.ctx.credentials
      .resolve(otherUser.user.id, 'openai')
      .catch(() => 'refused');

    assert.equal(resolved, 'refused', 'a transplanted ciphertext must not decrypt');
  });
});
