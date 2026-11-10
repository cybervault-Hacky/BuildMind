/* ==========================================================================
   BuildMind API — security/cookies.ts
   One cookie policy, defined once.

   HttpOnly  — page script cannot read the session token.
   SameSite  — 'lax' in development (so http://localhost works), 'strict' in
               production. Neither replaces CSRF tokens; they reduce surface.
   Secure    — required in production; off in development because a Secure
               cookie over http:// is silently dropped and would look like a
               broken login rather than a config error.
   Path '/'  — the API owns the cookie across its whole prefix.
   ========================================================================== */

import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Env } from '../config/env.js';

export function cookieOptions(env: Env, expiresAt: Date): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? 'strict' : 'lax',
    path: '/',
    expires: expiresAt,
  };
}
