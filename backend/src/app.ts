/* ==========================================================================
   BuildMind API — app.ts
   Builds the Fastify instance. One function, fully parameterised, so tests
   construct an isolated app rather than sharing module state.

   Cross-cutting concerns installed here, in order:
     1. request id + structured logging with secret scrubbing
     2. security headers
     3. CORS — an explicit origin allowlist, never '*'
     4. rate limiting (global, with stricter per-route buckets in routes)
     5. cookie parsing, body limit
     6. routes under /api/v1
     7. the single error handler
   ========================================================================== */

import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { MAX_REQUEST_BYTES } from './config/constants.js';
import { loadEnv, type Env } from './config/env.js';
import { createPool } from './db/pool.js';
import { Logger } from './utils/logger.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { registerRoutes } from './routes/index.js';
import { AuthService } from './services/auth/authService.js';
import { ProjectService } from './services/projects/projectService.js';
import { CredentialService } from './services/ai/credentialService.js';
import { BuildRepository } from './repositories/builds/buildRepository.js';
import { BuildOrchestrator } from './services/builds/buildOrchestrator.js';
import { BuildService } from './services/builds/buildService.js';
import { RobloxService } from './services/roblox/robloxService.js';
import { RobloxProvider } from './providers/roblox/robloxProvider.js';
import { StudioBridge } from './services/studio/studioBridge.js';
import { ProviderRegistry } from './providers/ai/registry.js';
import { BuildEventBus } from './events/buildEventBus.js';
import { WorkspaceManager } from './workspace/workspaceManager.js';
import { CleanupService } from './jobs/cleanupService.js';
import { securityHeaders } from './security/headers.js';
import type { AppContext } from './context.js';

export interface BuildAppOptions {
  /** Defaults to loadEnv(), which throws on an invalid environment. */
  env?: Env;
  /** Override for tests: a logger whose buffer the suite can inspect. */
  logger?: Logger;
  /** Skip the workspace cleanup timer (tests drive cleanup explicitly). */
  disableBackgroundJobs?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const env = options.env ?? loadEnv();
  const logger = options.logger ?? new Logger(env.isTest ? 'error' : 'info');

  const app = Fastify({
    // A request id on every log line makes a build traceable end to end.
    genReqId: () => crypto.randomUUID(),
    bodyLimit: MAX_REQUEST_BYTES,
    trustProxy: env.TRUST_PROXY,
    // Fastify's own logger is off; the app logs through utils/logger so that
    // every line passes the secret scrubber.
    logger: false,
  });

  const pool = createPool({ connectionString: env.DATABASE_URL });

  /* ------------------------------------------------------- cross-cutting -- */

  app.addHook('onRequest', async (request) => {
    (request as unknown as { startedAt: number }).startedAt = Date.now();
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = (request as unknown as { startedAt?: number }).startedAt ?? Date.now();
    logger.info({
      event: 'request.completed',
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      status: reply.statusCode,
      duration: Date.now() - startedAt,
      result: reply.statusCode < 400 ? 'ok' : 'error',
    });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    securityHeaders(reply, env);
    return payload;
  });

  await app.register(cookie, {});
  await app.register(cors, {
    origin: (origin, callback) => {
      // No origin = same-origin navigation or a non-browser client. Allow it,
      // because the credentials are still checked per request.
      if (!origin) return callback(null, true);
      if (origin === env.APP_ORIGIN) return callback(null, true);
      // Development convenience: the frontend may be served from another port.
      if (env.isDevelopment || env.isTest) {
        if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-studio-token'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // A per-IP bucket: no shared global counter that one client can exhaust.
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
    }),
  });

  /* ------------------------------------------------------------- context -- */

  const providers = new ProviderRegistry(env);
  const bus = new BuildEventBus(new EventEmitter().setMaxListeners(200));
  const auth = new AuthService(pool);
  const projects = new ProjectService(pool);
  const credentials = new CredentialService(pool, env.ENCRYPTION_KEY, providers);
  const workspace = new WorkspaceManager(env.WORKSPACE_ROOT);

  const orchestrator = new BuildOrchestrator({
    builds: new BuildRepository(pool),
    projects,
    workspace,
    bus,
    providers,
  });

  const builds = new BuildService(pool, orchestrator, credentials);

  const robloxProvider = new RobloxProvider({
    ...(env.ROBLOX_CLIENT_ID ? { clientId: env.ROBLOX_CLIENT_ID } : {}),
    ...(env.ROBLOX_CLIENT_SECRET ? { clientSecret: env.ROBLOX_CLIENT_SECRET } : {}),
    ...(env.ROBLOX_REDIRECT_URI ? { redirectUri: env.ROBLOX_REDIRECT_URI } : {}),
  });
  const roblox = new RobloxService(pool, robloxProvider, env.ENCRYPTION_KEY);
  const studio = new StudioBridge(pool);

  const cleanup = new CleanupService(pool, auth, workspace, studio, logger);

  const ctx: AppContext = {
    env,
    logger,
    pool,
    auth,
    projects,
    builds,
    orchestrator,
    credentials,
    roblox,
    studio,
    providers,
    bus,
    workspace,
    cleanup,
  };

  registerErrorHandler(app, logger);
  await registerRoutes(app, ctx);

  // Background sweeps. Off by default in tests so timing is deterministic.
  if (!options.disableBackgroundJobs && !env.isTest) {
    const interval = setInterval(() => {
      void cleanup.run().catch((err: unknown) => {
        logger.error({ event: 'cleanup.failed', message: err instanceof Error ? err.message : 'unknown' });
      });
    }, 60 * 60 * 1000);
    interval.unref();
    app.addHook('onClose', async () => clearInterval(interval));
  }

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return { app, ctx };
}
