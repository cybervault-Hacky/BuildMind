/* ==========================================================================
   BuildMind API — routes/health.routes.ts
   Liveness and readiness.

   /health  — is the process up? No database call, no config detail.
   /ready   — can it serve traffic? One cheap database round trip.

   Neither exposes a connection string, a version of a dependency, an
   environment variable or a secret. The responses are intentionally boring.
   ========================================================================== */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health', async () => ({ ok: true, data: { status: 'ok' } }));

  app.get('/ready', async (_request, reply) => {
    try {
      await ctx.pool.query('SELECT 1');
      return { ok: true, data: { status: 'ready', database: 'reachable' } };
    } catch {
      return reply.status(503).send({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'The service is not ready.' },
      });
    }
  });
}
