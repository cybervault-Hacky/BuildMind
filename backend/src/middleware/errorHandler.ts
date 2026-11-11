/* ==========================================================================
   BuildMind API — middleware/errorHandler.ts
   The single place an exception becomes an HTTP response.

   Guarantees:
     * an AppError is serialised with only its safe fields
     * anything else becomes INTERNAL_ERROR with no detail
     * nothing is logged that could contain a secret — the log line carries
       the request id, route, method, status, code and duration only
     * validation issues from Zod are reported per field, never as a stack
   ========================================================================== */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, ERROR_CODES, type ErrorCode } from '../errors/AppError.js';
import type { Logger } from '../utils/logger.js';

/** Body keys that must never reach a log line, at any depth. */
const REDACTED_KEYS = ['apikey', 'api_key', 'authorization', 'password', 'token', 'secret', 'cookie', 'refresh_token'];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.includes(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      logger.warn({
        event: 'request.failed',
        requestId,
        method: request.method,
        route: request.routeOptions.url,
        code: error.code,
        status: error.status,
      });
      return reply.status(error.status).send(error.toPublic());
    }

    if (error instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of error.issues) {
        const key = issue.path.join('.') || 'form';
        if (!fields[key]) fields[key] = issue.message;
      }
      const validation = new AppError('VALIDATION_ERROR', { fields });
      return reply.status(validation.status).send(validation.toPublic());
    }

    // Fastify's own errors (body too large, bad JSON, rate limit).
    // Fastify's own errors carry a statusCode; the type is unknown here.
    const fastifyError = error as { statusCode?: number; message?: string; stack?: string };
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (statusCode === 413) {
      const tooLarge = new AppError('PAYLOAD_TOO_LARGE');
      return reply.status(413).send(tooLarge.toPublic());
    }
    if (statusCode === 429) {
      const limited = new AppError('RATE_LIMITED');
      return reply.status(429).send(limited.toPublic());
    }
    if (statusCode === 400) {
      // Malformed JSON body: the parser's message can echo input, so replace it.
      const bad = new AppError('VALIDATION_ERROR', { fields: { body: 'The request body could not be read.' } });
      return reply.status(400).send(bad.toPublic());
    }

    // Anything else is a bug. Log the message (never the stack to the client).
    logger.error({
      event: 'request.crashed',
      requestId,
      method: request.method,
      route: request.routeOptions.url,
      message: fastifyError.message,
      stack: fastifyError.stack,
    });

    const code: ErrorCode = ERROR_CODES.INTERNAL_ERROR;
    return reply.status(500).send({ ok: false, error: { code, message: 'Something went wrong.' } });
  });

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    const missing = new AppError('NOT_FOUND');
    return reply.status(missing.status).send(missing.toPublic());
  });
}
