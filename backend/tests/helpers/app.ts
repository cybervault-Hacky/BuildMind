/* ==========================================================================
   BuildMind API — tests/helpers/app.ts
   Build a fully wired app against a test database, plus an HTTP client that
   carries cookies and the CSRF token the way a browser would.

   Nothing here mocks the application: the app is the real composition root,
   pointed at a real PostgreSQL schema. Only the AI provider is swappable, and
   only through the registry's test-only path.
   ========================================================================== */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { Logger } from '../../src/utils/logger.js';
import type { AppContext } from '../../src/context.js';
import type { FastifyInstance } from 'fastify';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  logger: Logger;
  workspaceRoot: string;
  close: () => Promise<void>;
}

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PORT: '0',
    APP_ORIGIN: 'http://localhost:8080',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://localhost/test',
    SESSION_SECRET: 'test-secret-that-is-long-enough-for-parsing-0123456789',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    GOOGLE_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    WORKSPACE_ROOT: '',
    TRUST_PROXY: 'false',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export async function createTestApp(options: {
  databaseUrl: string;
  envOverrides?: Record<string, string>;
  workspaceRoot?: string;
}): Promise<TestApp> {
  const workspaceRoot = options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), 'bm-ws-')));
  const logger = new Logger('info');
  const env = testEnv({
    DATABASE_URL: options.databaseUrl,
    WORKSPACE_ROOT: workspaceRoot,
    ...(options.envOverrides ?? {}),
  });

  const { app, ctx } = await buildApp({ env, logger, disableBackgroundJobs: true });
  await app.ready();

  return {
    app,
    ctx,
    logger,
    workspaceRoot,
    close: async () => {
      await app.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A minimal browser-like client: keeps the session cookie and the CSRF token,
 * and attaches both the way the real frontend does.
 */
export class TestClient {
  private cookie = '';
  private csrf = '';

  constructor(private readonly app: FastifyInstance) {}

  get cookieHeader(): string {
    return this.cookie;
  }

  private capture(headers: Record<string, unknown>): void {
    const setCookie = headers['set-cookie'];
    if (typeof setCookie === 'string') {
      const pair = setCookie.split(';')[0] ?? '';
      if (pair) this.cookie = pair;
    } else if (Array.isArray(setCookie) && typeof setCookie[0] === 'string') {
      const pair = setCookie[0].split(';')[0] ?? '';
      if (pair) this.cookie = pair;
    }
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;

    const response = await this.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

    this.capture(response.headers as Record<string, unknown>);

    let body: any = null;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = response.body;
    }

    // Every successful auth response carries a fresh CSRF token.
    if (body && body.ok && body.data && typeof body.data.csrfToken === 'string') {
      this.csrf = body.data.csrfToken;
    }
    const me = await Promise.resolve(body);
    if (me && me.ok && me.data && me.data.authenticated && typeof me.data.csrfToken === 'string') {
      this.csrf = me.data.csrfToken;
    }

    return { status: response.statusCode, body, headers: response.headers as Record<string, unknown> };
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, payload, headers);
  }
  patch(url: string, payload?: unknown) {
    return this.request('PATCH', url, payload);
  }
  delete(url: string) {
    return this.request('DELETE', url);
  }

  /** Register and adopt the resulting session. */
  async register(email = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, password = 'correct-horse-battery') {
    const res = await this.post('/api/v1/auth/register', { email, password, displayName: 'Test User' });
    if (!res.body?.ok) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return { email, password, user: res.body.data.user as { id: string; email: string } };
  }

  async login(email: string, password: string) {
    return this.post('/api/v1/auth/login', { email, password });
  }
}
