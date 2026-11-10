/* ==========================================================================
   BuildMind API — security/headers.ts
   Security headers for the API's own responses.

   Scope note: these headers protect responses served by *this* backend. The
   static frontend is served by a different host, and its headers are a
   deployment requirement documented in DEPLOYMENT.md — this file cannot and
   does not set them.

   The API returns JSON only, so its CSP is maximally restrictive rather than
   trying to mirror the frontend's document policy.
   ========================================================================== */

import type { FastifyReply } from 'fastify';
import type { Env } from '../config/env.js';

export function securityHeaders(reply: FastifyReply, env: Env): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('cross-origin-opener-policy', 'same-origin');

  if (env.isProduction) {
    // Only meaningful over HTTPS; stated as a deployment requirement too.
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}
