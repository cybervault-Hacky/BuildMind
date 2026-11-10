/* ==========================================================================
   BuildMind API — routes/projects.routes.ts
   CRUD over the authenticated user's projects.

   Note what is NOT here: no endpoint accepts a userId. The owner always comes
   from the session, so a client cannot ask for another user's list.
   ========================================================================== */

import type { FastifyInstance } from 'fastify';
import { CreateProjectSchema, ListProjectsSchema, UpdateProjectSchema, Uuid } from '../validation/schemas.js';
import { requireSession, userIdOf } from '../middleware/authGuard.js';
import { verifyCsrf } from '../middleware/csrf.js';
import { sessionOf } from '../middleware/authGuard.js';
import type { AppContext } from '../context.js';

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireSession(ctx.auth);

  app.get('/projects', { preHandler: guard }, async (request) => {
    const query = ListProjectsSchema.parse(request.query);
    const result = await ctx.projects.list(userIdOf(request), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { search: query.q } : {}),
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return { ok: true, data: result };
  });

  app.post('/projects', { preHandler: guard }, async (request, reply) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const input = CreateProjectSchema.parse(request.body);
    const project = await ctx.projects.create(userIdOf(request), input);
    return reply.status(201).send({ ok: true, data: { project } });
  });

  app.get('/projects/:id', { preHandler: guard }, async (request) => {
    const params = Uuid.parse((request.params as { id: string }).id);
    const project = await ctx.projects.get(userIdOf(request), params);
    return { ok: true, data: { project } };
  });

  app.patch('/projects/:id', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const id = Uuid.parse((request.params as { id: string }).id);
    const patch = UpdateProjectSchema.parse(request.body);
    const project = await ctx.projects.update(userIdOf(request), id, patch);
    return { ok: true, data: { project } };
  });

  app.delete('/projects/:id', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const id = Uuid.parse((request.params as { id: string }).id);
    await ctx.projects.delete(userIdOf(request), id);
    return { ok: true, data: { id } };
  });
}
