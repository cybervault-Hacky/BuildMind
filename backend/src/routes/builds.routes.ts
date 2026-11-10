/* ==========================================================================
   BuildMind API — routes/builds.routes.ts
   Create, read, cancel, retry, and follow a build as Server-Sent Events.

   SSE rather than WebSockets: events are one-directional, the browser
   reconnects natively, and a proxy understands them without an upgrade.
   The client supplies `?after=<seq>` and the handler replays persisted events
   before switching to live, so a reconnect never loses a stage.

   The stream is bound to the build's *current* runId. If a retry starts a new
   run while a client is attached, that stream ends and the client reconnects
   against the new run — an old stream never reports the new run's progress.
   ========================================================================== */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { CreateBuildSchema, EventsQuerySchema, ListBuildsSchema, Uuid } from '../validation/schemas.js';
import { requireSession, sessionOf, userIdOf } from '../middleware/authGuard.js';
import { verifyCsrf } from '../middleware/csrf.js';
import { isTerminal } from '../services/builds/stateMachine.js';
import type { AppContext } from '../context.js';

export async function buildRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireSession(ctx.auth);

  app.get('/builds', { preHandler: guard }, async (request) => {
    const query = ListBuildsSchema.parse(request.query);
    const builds = await ctx.builds.list(userIdOf(request), {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      limit: query.limit,
    });
    return { ok: true, data: { builds } };
  });

  app.post('/builds', { preHandler: guard }, async (request, reply) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const input = CreateBuildSchema.parse(request.body);
    const build = await ctx.builds.create(userIdOf(request), input);
    return reply.status(202).send({ ok: true, data: { build } });
  });

  app.get('/builds/:id', { preHandler: guard }, async (request) => {
    const id = Uuid.parse((request.params as { id: string }).id);
    const build = await ctx.builds.get(userIdOf(request), id);
    return { ok: true, data: { build } };
  });

  app.post('/builds/:id/cancel', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const id = Uuid.parse((request.params as { id: string }).id);
    const build = await ctx.builds.cancel(userIdOf(request), id);
    return { ok: true, data: { build } };
  });

  app.post('/builds/:id/retry', { preHandler: guard }, async (request, reply) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const id = Uuid.parse((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { apiKey?: string };
    const build = await ctx.builds.retry(userIdOf(request), id, {
      ...(typeof body.apiKey === 'string' && body.apiKey.length >= 8 ? { apiKey: body.apiKey } : {}),
    });
    return reply.status(202).send({ ok: true, data: { build } });
  });

  /** One-shot event list — used for tests and for a client without EventSource. */
  app.get('/builds/:id/events', { preHandler: guard }, async (request) => {
    const id = Uuid.parse((request.params as { id: string }).id);
    const query = EventsQuerySchema.parse(request.query);
    const result = await ctx.builds.events(userIdOf(request), id, query.after);
    return { ok: true, data: result };
  });

  /* ------------------------------------------------------------------------
     SSE stream
     ------------------------------------------------------------------------ */
  app.get('/builds/:id/stream', { preHandler: guard }, async (request, reply: FastifyReply) => {
    const id = Uuid.parse((request.params as { id: string }).id);
    const query = EventsQuerySchema.parse(request.query);

    // Authorise before opening the stream: an unowned build is a 404 here, and
    // the response is a normal JSON error rather than an empty event stream.
    const { build, runId } = await ctx.builds.currentRunId(userIdOf(request), id);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeat proxy buffering so stages arrive as they happen.
      'x-accel-buffering': 'no',
    });

    let closed = false;
    let seq = query.after;

    const send = (event: unknown): void => {
      if (closed) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay anything already persisted, so a reconnect is lossless.
    const replay = await ctx.builds.events(userIdOf(request), id, seq);
    for (const event of replay.events) {
      send(event);
      seq = Math.max(seq, event.seq);
    }

    if (isTerminal(build.status)) {
      send({ status: build.status, terminal: true, progress: build.progress });
      closed = true;
      reply.raw.end();
      return reply;
    }

    // Declared before the subscriber so the terminal path can stop the
    // heartbeat. Without this, a completed stream left a 15s interval running
    // for the lifetime of the process.
    let heartbeat: NodeJS.Timeout | null = null;
    let detach: (() => void) | null = null;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      detach?.();
      detach = null;
      try {
        reply.raw.end();
      } catch {
        // Already ended: nothing to do.
      }
    };

    detach = ctx.bus.subscribe(id, runId, (event) => {
      if (closed) return;
      if (event.seq <= seq) return;
      seq = event.seq;
      send(event);
      if (isTerminal(event.status as never)) {
        send({ status: event.status, terminal: true, progress: event.progress });
        cleanup();
      }
    });

    // A heartbeat keeps intermediaries from closing an idle stream.
    heartbeat = setInterval(() => {
      if (closed) return;
      reply.raw.write(': keep-alive\n\n');
    }, 15_000);

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    return reply;
  });
}
