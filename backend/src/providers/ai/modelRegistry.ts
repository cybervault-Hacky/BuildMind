/* ==========================================================================
   BuildMind API — providers/ai/modelRegistry.ts
   The only place a model id is written down.

   The build engine asks for a model by id and never hard-codes one. A request
   naming a model that does not belong to the requested provider is rejected
   here, so a client cannot pair OpenAI's endpoint with a Gemini model name.

   `managed: true` marks models BuildMind will serve on its own credentials.
   That is a product decision recorded in data, not scattered through code.
   ========================================================================== */

import type { ModelDefinition } from './types.js';

const MODELS: readonly ModelDefinition[] = [
  /* ------------------------------------------------------------- OpenAI -- */
  {
    id: 'gpt-4.1',
    displayName: 'GPT-4.1',
    provider: 'openai',
    supportsStructuredOutput: true,
    supportsStreaming: true,
    contextLimit: 1_047_576,
    maxOutputTokens: 4096,
  },
  {
    id: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    provider: 'openai',
    supportsStructuredOutput: true,
    supportsStreaming: true,
    contextLimit: 1_047_576,
    maxOutputTokens: 4096,
  },
  {
    id: 'o4-mini',
    displayName: 'o4-mini',
    provider: 'openai',
    supportsStructuredOutput: true,
    supportsStreaming: false,
    contextLimit: 200_000,
    maxOutputTokens: 4096,
  },
  /* ------------------------------------------------------------- Google -- */
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    supportsStructuredOutput: true,
    supportsStreaming: true,
    contextLimit: 1_048_576,
    maxOutputTokens: 4096,
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    supportsStructuredOutput: true,
    supportsStreaming: true,
    contextLimit: 1_048_576,
    maxOutputTokens: 4096,
  },
];

/** The default model per provider, used when a caller does not name one. */
export const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4.1-mini',
  google: 'gemini-2.5-flash',
};

export function listModels(provider?: string): ModelDefinition[] {
  const source = provider ? MODELS.filter((m) => m.provider === provider) : MODELS;
  return source.map((m) => ({ ...m }));
}

export function findModel(provider: string, modelId: string): ModelDefinition | null {
  const found = MODELS.find((m) => m.provider === provider && m.id === modelId);
  return found ? { ...found } : null;
}

export function findModelAnywhere(modelId: string): ModelDefinition | null {
  const found = MODELS.find((m) => m.id === modelId);
  return found ? { ...found } : null;
}

/** True when `modelId` is a registered model belonging to `provider`. */
export function isModelForProvider(provider: string, modelId: string): boolean {
  return MODELS.some((m) => m.provider === provider && m.id === modelId);
}
