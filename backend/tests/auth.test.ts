/* ==========================================================================
   BuildMind API — tests/auth.test.ts
   Registration, login, session lifecycle, and the properties that make
   authentication trustworthy:

     * duplicate registration is refused by the unique index
     * a wrong password and an unknown email are indistinguishable
     * a password hash never appears in a response
     * logout actually invalidates the session (not just the cookie)
     * an expired session is rejected
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

describe('registration', () => {
  it('creates an account and returns no password material', async () => {
    const client = new TestClient(testApp.app);
    const res = await client.post('/api/v1/auth/register', {
      email: 'new@example.com',
      password: 'correct-horse-battery',
      displayName: 'New User',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.user.email, 'new@example.com');
    assert.equal(res.body.data.user.displayName, 'New User');

    // No hash, no token, no salt anywhere in the payload.
    const payload = JSON.stringify(res.body);
    assert.ok(!/scrypt\$/.test(payload), 'response must not contain a password hash');
    assert.ok(!('passwordHash' in res.body.data.user));
    assert.ok(!('password' in res.body.data.user));
  });

  it('rejects a duplicate email, case-insensitively', async () => {
    const client = new TestClient(testApp.app);
    await client.register('dupe@example.com', 'correct-horse-battery');

    const second = await new TestClient(testApp.app).post('/api/v1/auth/register', {
      email: 'DUPE@example.com',
      password: 'another-long-password',
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'CONFLICT');
    assert.match(second.body.error.fields.email, /already registered/i);
  });

  it('rejects a short password', async () => {
    const res = await new TestClient(testApp.app).post('/api/v1/auth/register', {
      email: 'short@example.com',
      password: 'short',
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    // A client must not be able to smuggle `role` or `userId` in.
    const res = await new TestClient(testApp.app).post('/api/v1/auth/register', {
      email: 'extra@example.com',
      password: 'correct-horse-battery',
      role: 'admin',
    });
    assert.equal(res.status, 422);
  });
});

describe('login', () => {
  it('accepts the right password and issues a session', async () => {
    const client = new TestClient(testApp.app);
    await client.register('login@example.com', 'correct-horse-battery');

    const fresh = new TestClient(testApp.app);
    const res = await fresh.login('login@example.com', 'correct-horse-battery');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.email, 'login@example.com');

    const me = await fresh.get('/api/v1/auth/me');
    assert.equal(me.body.data.authenticated, true);
  });

  it('sets an HttpOnly, SameSite cookie and never returns the token in the body', async () => {
    const client = new TestClient(testApp.app);
    const res = await client.post('/api/v1/auth/register', {
      email: 'cookie@example.com',
      password: 'correct-horse-battery',
    });

    const raw = res.headers['set-cookie'];
    const cookieText = Array.isArray(raw) ? String(raw[0]) : String(raw);
    assert.match(cookieText, /HttpOnly/i);
    assert.match(cookieText, /SameSite=/i);
    assert.match(cookieText, /Path=\//);

    // The session token must not be readable from JSON.
    assert.ok(!('token' in res.body.data));
    assert.ok(!JSON.stringify(res.body).includes('bm_session'));
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const client = new TestClient(testApp.app);
    await client.register('known@example.com', 'correct-horse-battery');

    const wrongPassword = await new TestClient(testApp.app).post('/api/v1/auth/login', {
      email: 'known@example.com',
      password: 'not-the-password',
    });
    const unknownEmail = await new TestClient(testApp.app).post('/api/v1/auth/login', {
      email: 'nobody@example.com',
      password: 'not-the-password',
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error.code, unknownEmail.body.error.code);
    assert.deepEqual(wrongPassword.body.error, unknownEmail.body.error);
  });
});

describe('sessions', () => {
  it('logout invalidates the session server-side, not only the cookie', async () => {
    const client = new TestClient(testApp.app);
    await client.register('logout@example.com', 'correct-horse-battery');
    const cookieBefore = client.cookieHeader;
    assert.ok(cookieBefore.length > 0);

    const out = await client.post('/api/v1/auth/logout');
    assert.equal(out.status, 200);

    // Replay the old cookie manually: the session row is revoked, so it fails.
    const replayed = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieBefore },
    });
    const body = JSON.parse(replayed.body);
    assert.equal(body.data.authenticated, false);
  });

  it('rejects a request with no session on a protected route', async () => {
    const res = await new TestClient(testApp.app).get('/api/v1/projects');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('rejects a forged session token', async () => {
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'bm_session=forged-token-value' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.data.authenticated, false);
  });

  it('rejects an expired session', async () => {
    const client = new TestClient(testApp.app);
    const registered = await client.register('expired@example.com', 'correct-horse-battery');

    // Push the expiry into the past, which is what "expired" means.
    await db.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1`,
      [registered.user.id],
    );

    const me = await client.get('/api/v1/auth/me');
    assert.equal(me.body.data.authenticated, false);

    const protectedRes = await client.get('/api/v1/projects');
    assert.equal(protectedRes.status, 401);
  });

  it('rejects a revoked session even before it expires', async () => {
    const client = new TestClient(testApp.app);
    const registered = await client.register('revoked@example.com', 'correct-horse-battery');

    await db.pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [registered.user.id]);

    const res = await client.get('/api/v1/projects');
    assert.equal(res.status, 401);
  });
});

describe('password storage', () => {
  it('stores a scrypt hash, never the password itself', async () => {
    const client = new TestClient(testApp.app);
    await client.register('hash@example.com', 'correct-horse-battery');

    const row = await db.pool.query<{ password_hash: string }>(`SELECT password_hash FROM users LIMIT 1`);
    const hash = row.rows[0]?.password_hash ?? '';

    assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.ok(!hash.includes('correct-horse-battery'));
  });
});
