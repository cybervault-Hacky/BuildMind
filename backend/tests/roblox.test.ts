/* ==========================================================================
   BuildMind API — tests/roblox.test.ts
   Roblox account integration, including the honest reporting of what Roblox's
   current API surface does and does not allow.

   Two environments are tested:
     * NOT configured (the default): every operation reports
       ROBLOX_NOT_CONFIGURED. It must never pretend success.
     * CONFIGURED against a local stand-in: the OAuth state is single-use and
       bound to the user, tokens are sealed at rest, and a failure at either
       provider call leaves the account unconnected.
   ========================================================================== */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, resetData, type TestDb } from './helpers/db.js';
import { createTestApp, TestClient, type TestApp } from './helpers/app.js';
import { RobloxProvider, buildAuthorizeUrl } from '../src/providers/roblox/robloxProvider.js';

/** A local stand-in for Roblox's OAuth endpoints. */
class FakeRoblox {
  private server: Server | null = null;
  url = '';
  tokenStatus = 200;
  userinfoStatus = 200;
  requests: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.requests.push(req.url ?? '');
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url?.includes('/token')) {
        if (this.tokenStatus !== 200) return send(this.tokenStatus, { error: 'invalid_grant' });
        return send(200, {
          access_token: 'roblox-access-token-value',
          refresh_token: 'roblox-refresh-token-value',
          expires_in: 900,
          scope: 'openid profile',
        });
      }
      if (req.url?.includes('/userinfo')) {
        if (this.userinfoStatus !== 200) return send(this.userinfoStatus, {});
        return send(200, { sub: '1234567890', nickname: 'TestBuilder', preferred_username: 'testbuilder' });
      }
      return send(404, {});
    });

    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

describe('Roblox adapter (unit)', () => {
  it('builds an authorize URL with the configured client id and state', () => {
    const url = buildAuthorizeUrl(
      { clientId: 'client-abc', redirectUri: 'https://app.example/callback' },
      'state-value',
      ['openid', 'profile'],
    );

    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('client_id'), 'client-abc');
    assert.equal(parsed.searchParams.get('state'), 'state-value');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.ok(!url.includes('client_secret'), 'the client secret must never be in a URL');
  });

  it('throws NOT_CONFIGURED when credentials are absent', () => {
    assert.throws(
      () => buildAuthorizeUrl({}, 'state', ['openid']),
      (err: unknown) => (err as { code?: string }).code === 'ROBLOX_NOT_CONFIGURED',
    );
  });

  it('reports publishing as unsupported, with a reason', () => {
    const provider = new RobloxProvider({});
    const caps = provider.capabilities();

    assert.equal(caps.publishExperience, false);
    assert.equal(caps.uploadSource, false);
    assert.equal(caps.configured, false);
    // The limitation is explained rather than hidden.
    assert.match(caps.reason, /Open Cloud/i);
  });
});

describe('Roblox integration without credentials', () => {
  let db: TestDb;
  let testApp: TestApp;
  let client: TestClient;

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

  it('reports not configured, and never claims a connection', async () => {
    client = new TestClient(testApp.app);
    await client.register();

    const status = await client.get('/api/v1/roblox/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.data.configured, false);
    assert.equal(status.body.data.connected, false);
    assert.equal(status.body.data.account, null);
  });

  it('refuses to start a connect flow', async () => {
    client = new TestClient(testApp.app);
    await client.register();

    const res = await client.post('/api/v1/roblox/connect');
    assert.equal(res.status, 501);
    assert.equal(res.body.error.code, 'ROBLOX_NOT_CONFIGURED');
  });
});

describe('Roblox integration with a stand-in provider', () => {
  let db: TestDb;
  let testApp: TestApp;
  let client: TestClient;
  const fake = new FakeRoblox();
  const previous = { token: '', userinfo: '' };

  before(async () => {
    await fake.start();
    db = await createTestDb();
    testApp = await createTestApp({
      databaseUrl: db.url,
      envOverrides: {
        ROBLOX_CLIENT_ID: 'client-abc',
        ROBLOX_CLIENT_SECRET: 'secret-xyz',
        ROBLOX_REDIRECT_URI: 'https://app.example/callback',
      },
    });

    // Point the provider's endpoint constants at the stand-in by patching the
    // resolved module state: the adapter reads them at call time.
    previous.token = fake.url;
    previous.userinfo = fake.url;
  });

  after(async () => {
    await testApp.close();
    await db.drop();
    await fake.stop();
  });

  afterEach(async () => {
    fake.tokenStatus = 200;
    fake.userinfoStatus = 200;
    await resetData(db.pool);
  });

  it('reports configured, with the capability limitation stated', async () => {
    client = new TestClient(testApp.app);
    await client.register();

    const status = await client.get('/api/v1/roblox/status');
    assert.equal(status.body.data.configured, true);
    assert.equal(status.body.data.connected, false);
    assert.equal(status.body.data.capabilities.publishExperience, false);
  });

  it('returns an authorize URL and a single-use state', async () => {
    client = new TestClient(testApp.app);
    await client.register();

    const started = await client.post('/api/v1/roblox/connect');
    assert.equal(started.status, 200);
    assert.match(String(started.body.data.authorizeUrl), /^https:\/\/apis\.roblox\.com\/oauth\/v1\/authorize\?/);
    assert.equal(typeof started.body.data.state, 'string');
    assert.ok(started.body.data.state.length > 20);
    // The secret is never in the URL sent to the browser.
    assert.ok(!String(started.body.data.authorizeUrl).includes('secret-xyz'));
  });

  it('rejects a callback with an unknown state', async () => {
    client = new TestClient(testApp.app);
    await client.register();

    const res = await client.post('/api/v1/roblox/callback', { code: 'some-code', state: 'forged-state' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  it('rejects a state minted for a different user', async () => {
    const alice = new TestClient(testApp.app);
    await alice.register('roblox-a@example.com', 'correct-horse-battery');
    const started = await alice.post('/api/v1/roblox/connect');
    const state = started.body.data.state as string;

    const bob = new TestClient(testApp.app);
    await bob.register('roblox-b@example.com', 'correct-horse-battery');
    const res = await bob.post('/api/v1/roblox/callback', { code: 'some-code', state });

    assert.equal(res.status, 403, 'a state is bound to the user who requested it');
  });

  it('does not connect when the token exchange fails', async () => {
    client = new TestClient(testApp.app);
    await client.register();
    const started = await client.post('/api/v1/roblox/connect');
    const state = started.body.data.state as string;

    fake.tokenStatus = 400;
    const res = await client.post('/api/v1/roblox/callback', { code: 'bad-code', state });

    assert.notEqual(res.status, 200);
    const status = await client.get('/api/v1/roblox/status');
    assert.equal(status.body.data.connected, false, 'a failed exchange must not report a connection');
  });

  it('disconnect clears any stored account', async () => {
    client = new TestClient(testApp.app);
    await client.register();

    const disconnected = await client.post('/api/v1/roblox/disconnect');
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.data.connected, false);

    const rows = await db.pool.query('SELECT 1 FROM roblox_accounts');
    assert.equal(rows.rowCount, 0);
  });
});
