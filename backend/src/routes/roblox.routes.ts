/* ==========================================================================
   BuildMind API — routes/roblox.routes.ts
   Account connection and Studio session plumbing.

   The status response includes the honest capability report, so the frontend
   can say "connected — publishing requires Open Cloud, which is not
   implemented" instead of implying a full pipeline.
   ========================================================================== */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RobloxConnectSchema, StudioMessageSchema, Uuid } from '../validation/schemas.js';
import { requireSession, sessionOf, userIdOf } from '../middleware/authGuard.js';
import { verifyCsrf } from '../middleware/csrf.js';
import type { AppContext } from '../context.js';

const StudioHandshakeSchema = z
  .object({
    buildId: Uuid,
    runId: Uuid,
  })
  .strict();

export async function robloxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireSession(ctx.auth);

  app.get('/roblox/status', { preHandler: guard }, async (request) => {
    const status = await ctx.roblox.status(userIdOf(request));
    return { ok: true, data: status };
  });

  /** Start the OAuth flow: returns the URL to send the browser to. */
  app.post('/roblox/connect', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const started = await ctx.roblox.beginConnect(userIdOf(request));
    return { ok: true, data: started };
  });

  /** Complete the flow with the code and state the provider returned. */
  app.post('/roblox/callback', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const input = RobloxConnectSchema.parse(request.body);
    const status = await ctx.roblox.connect(userIdOf(request), input.code, input.state);
    return { ok: true, data: status };
  });

  app.post('/roblox/disconnect', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const status = await ctx.roblox.disconnect(userIdOf(request));
    return { ok: true, data: status };
  });

  /* ------------------------------------------------------- Studio bridge -- */

  app.get('/studio/status', { preHandler: guard }, async (request) => {
    const status = await ctx.studio.status(userIdOf(request));
    return { ok: true, data: status };
  });

  /** A plugin registers and receives its token once. */
  app.post('/studio/session', { preHandler: guard }, async (request, reply) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const session = await ctx.studio.registerSession(userIdOf(request));
    return reply.status(201).send({ ok: true, data: session });
  });

  app.delete('/studio/session/:id', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const id = Uuid.parse((request.params as { id: string }).id);
    const revoked = await ctx.studio.revokeSession(id, userIdOf(request));
    return { ok: true, data: { id, revoked } };
  });

  /**
   * Inbound plugin message.
   *
   * Authenticated by the session token in the `x-studio-token` header — not by
   * the cookie, because a plugin is not a browser. The route is therefore
   * exempt from CSRF (there is no ambient credential to abuse).
   */
  app.post('/studio/message', async (request) => {
    const raw = request.headers['x-studio-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, error: { code: 'STUDIO_UNAUTHORIZED', message: 'That Studio session is not authorized.' } };
    }

    const parsed = StudioMessageSchema.safeParse(request.body);
    const buildId = parsed.success ? parsed.data.buildId : null;

    const result = await ctx.studio.handleMessage(token, request.body, async (userId, id) => {
      if (!buildId) return false;
      const build = await ctx.builds.get(userId, id).catch(() => null);
      return Boolean(build);
    });

    return { ok: true, data: result };
  });

  /** Queue a completed build for delivery to a connected Studio session. */
  app.post('/studio/deliver', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const input = StudioHandshakeSchema.parse(request.body);
    const build = await ctx.builds.get(userIdOf(request), input.buildId);
    // Only a completed build is ever delivered: offering a failed build to
    // Studio would invite it to be reported as valid.
    if (build.status !== 'complete') {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_INCOMPLETE',
          message: 'Only a completed build can be delivered to Studio.',
        },
      };
    }
    await ctx.studio.queueDelivery(userIdOf(request), input.buildId, input.runId ?? build.runId);
    return { ok: true, data: { queued: true, buildId: input.buildId, runId: input.runId ?? build.runId } };
  });
}
