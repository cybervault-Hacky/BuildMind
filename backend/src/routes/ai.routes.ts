/* ==========================================================================
   BuildMind API — routes/ai.routes.ts
   Provider listing, model listing, credential validation.

   The validation endpoint is the only way the UI may show "Valid", and it
   always makes a real provider request. There is no cached "valid" flag and
   no optimistic success: a provider that cannot be reached is reported as
   unavailable, not valid.

   The API key arrives in a JSON body over HTTPS. It is never accepted from a
   query string, never returned, and never echoed in an error.
   ========================================================================== */

import type { FastifyInstance } from 'fastify';
import { ProviderModelsSchema, ValidateProviderSchema } from '../validation/schemas.js';
import { requireSession, sessionOf, userIdOf } from '../middleware/authGuard.js';
import { verifyCsrf } from '../middleware/csrf.js';
import { AppError } from '../errors/AppError.js';
import { listModels } from '../providers/ai/modelRegistry.js';
import type { AppContext } from '../context.js';

export async function aiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const guard = requireSession(ctx.auth);

  app.get('/ai/providers', { preHandler: guard }, async (request) => {
    const stored = await ctx.credentials.list(userIdOf(request));
    return {
      ok: true,
      data: {
        providers: ctx.providers.statuses(),
        // Only hints are exposed — never a key, not even a prefix beyond 3 chars.
        credentials: stored,
      },
    };
  });

  app.get('/ai/providers/:provider/models', { preHandler: guard }, async (request) => {
    const { provider } = ProviderModelsSchema.parse(request.params);
    if (!ctx.providers.has(provider)) throw new AppError('CONFIGURATION_ERROR');
    return { ok: true, data: { provider, models: listModels(provider) } };
  });

  /**
   * Real credential validation.
   *
   * `status` distinguishes every outcome the UI must show:
   *   valid | invalid | unavailable | not_configured
   * A request with no key and no stored/managed credential is
   * `not_configured` — it does not silently "pass".
   */
  app.post('/ai/validate', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const input = ValidateProviderSchema.parse(request.body);
    const userId = userIdOf(request);

    if (!ctx.providers.has(input.provider)) {
      throw new AppError('CONFIGURATION_ERROR', { fields: { provider: 'Unknown provider.' } });
    }

    const credential = await ctx.credentials.resolve(userId, input.provider, input.apiKey);
    if (!credential) {
      return {
        ok: true,
        data: { status: 'not_configured', valid: false, detail: 'Add a provider key first.' },
      };
    }

    // Persist a supplied key only after it proves usable, so a typo does not
    // overwrite a working stored credential.
    const provider = ctx.providers.get(input.provider);
    let result;
    try {
      result = await provider.validateCredentials(credential);
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'PROVIDER_UNAVAILABLE';
      const unavailable = code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_TIMEOUT';
      return {
        ok: true,
        data: {
          status: unavailable ? 'unavailable' : 'invalid',
          valid: false,
          detail: unavailable ? 'The provider is not reachable right now.' : 'That key could not be used.',
        },
      };
    }

    if (result.valid) {
      if (input.apiKey) await ctx.credentials.store(userId, input.provider, input.apiKey);
      // Model pairing is checked here too, so the UI cannot claim a model that
      // does not belong to the validated provider.
      if (input.model && !listModels(input.provider).some((m) => m.id === input.model)) {
        return {
          ok: true,
          data: { status: 'invalid', valid: false, detail: 'That model is not available for this provider.' },
        };
      }
    }

    return {
      ok: true,
      data: {
        status: result.valid ? 'valid' : 'invalid',
        valid: result.valid,
        detail: result.detail ?? null,
        source: credential.source,
      },
    };
  });

  /** Forget a stored BYOK key. */
  app.delete('/ai/credentials/:provider', { preHandler: guard }, async (request) => {
    verifyCsrf(request, sessionOf(request).sessionId);
    const { provider } = ProviderModelsSchema.parse(request.params);
    const removed = await ctx.credentials.forget(userIdOf(request), provider);
    return { ok: true, data: { provider, removed } };
  });
}
