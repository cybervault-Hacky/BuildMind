/* ==========================================================================
   BuildMind API — routes/auth.routes.ts
   register / login / logout / me

   The session token is set as an HttpOnly cookie and never appears in a JSON
   body, so page script cannot read it and it cannot end up in browser history
   or a shared URL.
   ========================================================================== */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { LoginSchema, RegisterSchema } from '../validation/schemas.js';
import { requireSession, readSessionToken, SESSION_COOKIE } from '../middleware/authGuard.js';
import { csrfTokenFor, forgetCsrf, verifyCsrf } from '../middleware/csrf.js';
import { cookieOptions } from '../security/cookies.js';
import type { AppContext } from '../context.js';

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { auth, env } = ctx;

  function issueCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(env, expiresAt));
  }

  app.post('/auth/register', async (request, reply) => {
    const input = RegisterSchema.parse(request.body);
    const issued = await auth.register(input);

    issueCookie(reply, issued.token, issued.expiresAt);
    const session = await auth.resolve(issued.token);
    // The CSRF token is bound to the session id, so it must be minted after.
    const csrf = session ? csrfTokenFor(session.sessionId, env.SESSION_SECRET) : '';

    return reply.status(201).send({
      ok: true,
      data: { user: issued.user, csrfToken: csrf, expiresAt: issued.expiresAt.toISOString() },
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const input = LoginSchema.parse(request.body);
    const issued = await auth.login(input);

    issueCookie(reply, issued.token, issued.expiresAt);
    const session = await auth.resolve(issued.token);
    const csrf = session ? csrfTokenFor(session.sessionId, env.SESSION_SECRET) : '';

    return reply.status(200).send({
      ok: true,
      data: { user: issued.user, csrfToken: csrf, expiresAt: issued.expiresAt.toISOString() },
    });
  });

  app.post('/auth/logout', { preHandler: requireSession(auth) }, async (request, reply) => {
    const session = request.session;
    if (session) {
      verifyCsrf(request, session.sessionId);
      forgetCsrf(session.sessionId);
    }
    await auth.logout(readSessionToken(request));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(200).send({ ok: true, data: { loggedOut: true } });
  });

  app.get('/auth/me', async (request, reply) => {
    // Tolerates an anonymous caller: this is how the UI decides what to show.
    const session = await auth.resolve(readSessionToken(request));
    if (!session) {
      return reply.status(200).send({ ok: true, data: { authenticated: false, user: null, csrfToken: null } });
    }

    return reply.status(200).send({
      ok: true,
      data: {
        authenticated: true,
        user: {
          id: session.user.id,
          email: session.user.email,
          displayName: session.user.displayName,
          createdAt: session.user.createdAt.toISOString(),
        },
        csrfToken: csrfTokenFor(session.sessionId, env.SESSION_SECRET),
      },
    });
  });
}
