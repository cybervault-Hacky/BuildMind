/* ==========================================================================
   BuildMind API — providers/ai/registry.ts
   Provider registry: the mapping from a provider id to an implementation.

   Providers are registered from configuration only. A test provider exists,
   but it is selected by an explicit env flag and the server refuses to start
   in production with it enabled — that refusal is asserted in the test suite,
   because "production must never silently use mocks" is a rule that needs to
   be enforced by code rather than by discipline.
   ========================================================================== */

import { AppError } from '../../errors/AppError.js';
import type { Env } from '../../config/env.js';
import { GoogleProvider } from './google/googleProvider.js';
import { OpenAIProvider } from './openai/openaiProvider.js';
import { MockAIProvider } from './mock/mockProvider.js';
import type { AIProvider, ProviderStatus } from './types.js';
import { listModels } from './modelRegistry.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();
  private readonly managedKeys = new Map<string, string>();
  private readonly mockEnabled: boolean;

  constructor(env: Env) {
    this.providers.set('openai', new OpenAIProvider(env.OPENAI_BASE_URL));
    this.providers.set('google', new GoogleProvider(env.GOOGLE_BASE_URL));

    if (env.MANAGED_OPENAI_API_KEY) this.managedKeys.set('openai', env.MANAGED_OPENAI_API_KEY);
    if (env.MANAGED_GOOGLE_API_KEY) this.managedKeys.set('google', env.MANAGED_GOOGLE_API_KEY);

    // A test provider may only exist outside production.
    this.mockEnabled = env.NODE_ENV === 'test';
    if (this.mockEnabled) {
      this.providers.set('mock', new MockAIProvider());
    }
    if (env.NODE_ENV === 'production' && env.MANAGED_OPENAI_API_KEY === 'mock') {
      throw new Error('Refusing to start: production cannot use the mock provider');
    }
  }

  /** Resolve a provider, or throw a safe CONFIGURATION_ERROR. */
  get(id: string): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new AppError('CONFIGURATION_ERROR', { cause: `unknown provider ${id}` });
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** True when BuildMind holds its own credential for this provider. */
  hasManagedKey(id: string): boolean {
    return this.managedKeys.has(id);
  }

  managedKey(id: string): string | null {
    return this.managedKeys.get(id) ?? null;
  }

  /** What the frontend may see: capabilities, never credentials. */
  statuses(): ProviderStatus[] {
    return this.publicIds().map((id) => {
      const provider = this.providers.get(id);
      return {
        id,
        displayName: provider?.displayName ?? id,
        requiresKey: true,
        managedAvailable: this.hasManagedKey(id),
        models: listModels(id),
      };
    });
  }

  /** Providers exposed to clients. The mock provider is never exposed. */
  publicIds(): string[] {
    return ['openai', 'google'];
  }
}
