/* ==========================================================================
   BuildMind API — middleware/csrf.ts
   Double-submit CSRF protection for cookie-authenticated state changes.

   Why this exists when the session cookie is SameSite=Lax:
   SameSite is a browser default, not a guarantee. Older clients, misconfigured
   proxies and same-site subdomain attackers all survive it. The phase rules
   explicitly say SameSite alone is not sufficient, so:

     * a random token is issued to the client and bound to the session id
       server-side (not just compared to a cookie, which a subdomain could set)
     * mutating requests must send it in the `x-csrf-token` header
     * GET/HEAD/OPTIONS are exempt (they must not change state anyway)
   ========================================================================== */

import { createHash } from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** sessionId → token issued to that session. */
const issued = new Map<string, string>();

function fingerprint(sessionId: string, secret: string): string {
  return createHash('sha256').update(`${sessionId}:${secret}`).digest('hex');
}

/** Mint (or reuse) the CSRF token for a session. */
export function csrfTokenFor(sessionId: string, sessionSecret: string): string {
  const existing = issued.get(sessionId);
  if (existing) return existing;
  const token = fingerprint(sessionId, sessionSecret).slice(0, 43);
  issued.set(sessionId, token);
  return token;
}

export function forgetCsrf(sessionId: string): void {
  issued.delete(sessionId);
}

/**
 * Verify the header against the token bound to this session.
 * Only applies to cookie-authenticated mutations; a request with no session is
 * rejected earlier by requireSession.
 */
export function verifyCsrf(request: FastifyRequest, sessionId: string): void {
  if (SAFE_METHODS.has(request.method)) return;

  const provided = request.headers[HEADER];
  const value = Array.isArray(provided) ? provided[0] : provided;
  const expected = issued.get(sessionId);

  if (!expected || typeof value !== 'string' || value.length === 0) {
    throw new AppError('FORBIDDEN', { cause: 'missing csrf token' });
  }
  if (value !== expected) {
    throw new AppError('FORBIDDEN', { cause: 'csrf token mismatch' });
  }
}

/** Exposed so the test suite can assert the store does not grow forever. */
export function csrfEntryCount(): number {
  return issued.size;
}

export type { FastifyReply };
