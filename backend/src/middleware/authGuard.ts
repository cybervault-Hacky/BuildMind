/* ==========================================================================
   BuildMind API — middleware/authGuard.ts
   Session cookie → authenticated request context.

   The cookie is HttpOnly, so page scripts cannot read it; the only way a
   request carries a session is the browser sending it. That is also why CSRF
   protection exists (see csrf.ts) — SameSite=Lax handles the common cases, and
   the double-submit token covers the rest.
   ========================================================================== */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/AppError.js';
import type { AuthService, SessionContext } from '../services/auth/authService.js';

export const SESSION_COOKIE = 'bm_session';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionContext;
  }
}

export function readSessionToken(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** A preHandler that rejects an unauthenticated request. */
export function requireSession(auth: AuthService) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const session = await auth.resolve(readSessionToken(request));
    if (!session) throw new AppError('UNAUTHENTICATED');
    request.session = session;
  };
}

/** Narrow helper: the session is guaranteed by requireSession. */
export function sessionOf(request: FastifyRequest): SessionContext {
  const session = request.session;
  if (!session) throw new AppError('UNAUTHENTICATED');
  return session;
}

export function userIdOf(request: FastifyRequest): string {
  return sessionOf(request).user.id;
}
