/* ==========================================================================
   BuildMind API — providers/ai/google/googleProvider.ts
   Real Google Gemini adapter (Generative Language API).

   Gemini's shape differs from OpenAI's in three ways that this adapter
   absorbs, so nothing downstream needs to know:
     * the credential travels in an `x-goog-api-key` header, not a bearer token
     * content sits in candidates[0].content.parts[].text, not a message string
     * JSON mode is `generationConfig.responseMimeType: application/json`

   Google's documented convenience form allows `?key=` in the query string.
   This adapter deliberately does not use it: a secret in a URL leaks into
   logs, proxies and browser history, all of which the phase rules forbid.
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

interface GeminiModelEntry {
  name?: string;
  supportedGenerationMethods?: string[];
}

interface GeminiModelsResponse {
  models?: GeminiModelEntry[];
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Registry ids read `gemini-2.5-pro`; the API wants `models/gemini-2.5-pro`. */
function apiModelName(id: string): string {
  return id.startsWith('models/') ? id : `models/${id}`;
}

function stripPrefix(name: string | undefined): string {
  return (name ?? '').replace(/^models\//, '');
}

export class GoogleProvider implements AIProvider {
  public readonly id = 'google';
  public readonly displayName = 'Google';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(credential: ProviderCredential): Record<string, string> {
    return { 'x-goog-api-key': credential.apiKey };
  }

  async validateCredentials(credential: ProviderCredential, signal?: AbortSignal): Promise<ValidationResult> {
    try {
      const res = await postJson({
        url: `${this.baseUrl}/models`,
        method: 'GET',
        headers: this.headers(credential),
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      });
      const body = res.json as GeminiModelsResponse | null;
      if (!body || !Array.isArray(body.models)) {
        return { valid: false, detail: 'Unexpected response from the provider.' };
      }
      const available = new Set(
        body.models
          .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => stripPrefix(m.name)),
      );
      const usable = registryModels('google').filter((m) => available.size === 0 || available.has(m.id));
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
    const body = res.json as GeminiModelsResponse | null;
    const available = new Set((body?.models ?? []).map((m) => stripPrefix(m.name)));
    return registryModels('google').filter((m) => available.size === 0 || available.has(m.id));
  }

  async generate(credential: ProviderCredential, request: GenerateRequest): Promise<GenerateResult> {
    const definition = findModel('google', request.model);
    if (!definition) throw new AppError('CONFIGURATION_ERROR', { cause: `unregistered google model ${request.model}` });

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: request.maxOutputTokens ?? definition.maxOutputTokens,
    };
    if (request.json) generationConfig.responseMimeType = 'application/json';
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;

    const res = await postJson({
      url: `${this.baseUrl}/${apiModelName(request.model)}:generateContent`,
      headers: this.headers(credential),
      body: {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const body = res.json as GeminiResponse | null;
    const candidate = body?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: 'empty candidates' });

    return {
      text,
      model: request.model,
      usage: {
        inputTokens: body?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
      },
      truncated: candidate?.finishReason === 'MAX_TOKENS',
    };
  }
}
