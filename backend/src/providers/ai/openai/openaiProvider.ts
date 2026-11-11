/* ==========================================================================
   BuildMind API — providers/ai/openai/openaiProvider.ts
   Real OpenAI adapter (Chat Completions API).

   Notes on the choices:

     * Validation calls GET /models — the cheapest real request that proves a
       key works. It spends no model tokens, which is what the "do not consume
       unnecessary tokens for validation" rule asks for.
     * Structured output uses `response_format: { type: "json_object" }` and
       the caller still validates the JSON against a schema. A provider that
       promises JSON is not a provider that promises the right JSON.
     * `temperature` is only sent for models that accept it; the o-series
       rejects sampling parameters, so sending them yields a 400.
     * The key is read from the credential argument on each call and is never
       captured in a field, a log line or an error message.
   ========================================================================== */

import { AppError } from '../../../errors/AppError.js';
import { postJson } from '../http.js';
import { findModel, listModels as registryModels } from '../modelRegistry.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  ModelDefinition,
  ProviderCredential,
  ValidationResult,
} from '../types.js';

interface OpenAIModelsResponse {
  data?: Array<{ id?: string }>;
}

interface OpenAIChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface OpenAIChatResponse {
  model?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Models that reject temperature/sampling parameters. */
function acceptsTemperature(model: string): boolean {
  return !/^(o\d|o-|gpt-5)/.test(model);
}

export class OpenAIProvider implements AIProvider {
  public readonly id = 'openai';
  public readonly displayName = 'OpenAI';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(credential: ProviderCredential): Record<string, string> {
    return { authorization: `Bearer ${credential.apiKey}` };
  }

  /**
   * A real request that cannot spend tokens: list models.
   * Anything other than an explicit success is reported as invalid or
   * unavailable — never optimistically as valid.
   */
  async validateCredentials(credential: ProviderCredential, signal?: AbortSignal): Promise<ValidationResult> {
    try {
      const res = await postJson({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.headers(credential),
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      });
      const body = res.json as OpenAIModelsResponse | null;
      if (!body || !Array.isArray(body.data)) {
        return { valid: false, detail: 'Unexpected response from the provider.' };
      }
      const available = new Set(body.data.map((m) => m.id).filter(Boolean));
      // A key can be valid yet lack access to every model we support.
      const usable = registryModels('openai').filter((m) => available.size === 0 || available.has(m.id));
      if (usable.length === 0) {
        return { valid: false, detail: 'That key has no access to a supported model.' };
      }
      return { valid: true, detail: `${usable.length} supported model(s) available.` };
    } catch (err) {
      return this.toValidationResult(err);
    }
  }

  private toValidationResult(err: unknown): ValidationResult {
    if (err instanceof AppError) {
      switch (err.code) {
        case 'PROVIDER_AUTH_FAILED':
          return { valid: false, detail: 'That key was rejected.' };
        case 'PROVIDER_RATE_LIMITED':
          return { valid: false, detail: 'The provider is rate limiting this key.' };
        case 'PROVIDER_TIMEOUT':
          return { valid: false, detail: 'The provider did not answer in time.' };
        case 'PROVIDER_UNAVAILABLE':
          return { valid: false, detail: 'The provider is not reachable right now.' };
        default:
          return { valid: false, detail: 'The provider returned an unexpected response.' };
      }
    }
    return { valid: false, detail: 'The provider could not be checked.' };
  }

  async listModels(credential: ProviderCredential, signal?: AbortSignal): Promise<ModelDefinition[]> {
    const res = await postJson({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: this.headers(credential),
      timeoutMs: 20_000,
      ...(signal ? { signal } : {}),
    });
    const body = res.json as OpenAIModelsResponse | null;
    const available = new Set((body?.data ?? []).map((m) => m.id).filter(Boolean));
    return registryModels('openai').filter((m) => available.size === 0 || available.has(m.id));
  }

  async generate(credential: ProviderCredential, request: GenerateRequest): Promise<GenerateResult> {
    const definition = findModel('openai', request.model);
    if (!definition) throw new AppError('CONFIGURATION_ERROR', { cause: `unregistered openai model ${request.model}` });

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_completion_tokens: request.maxOutputTokens ?? definition.maxOutputTokens,
    };
    if (request.json) payload.response_format = { type: 'json_object' };
    if (acceptsTemperature(request.model) && request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }

    const res = await postJson({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.headers(credential),
      body: payload,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const body = res.json as OpenAIChatResponse | null;
    const choice = body?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: 'empty completion' });
    }

    return {
      text,
      model: body?.model ?? request.model,
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? 0,
      },
      truncated: choice?.finish_reason === 'length',
    };
  }
}
