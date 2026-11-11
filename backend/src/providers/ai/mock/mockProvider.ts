/* ==========================================================================
   BuildMind API — providers/ai/mock/mockProvider.ts
   A deterministic provider for tests. It exists so the build engine's
   orchestration, state machine and event flow can be exercised without a
   network or a paid credential.

   This is NOT a fake-success path in the product:
     * the registry only registers it when NODE_ENV === 'test'
     * it is never listed in ProviderRegistry.publicIds(), so no client can
       select it
     * it refuses any credential that is not an obvious test key, so it cannot
       be reached by accident from a real deployment
   ========================================================================== */

import { AppError } from '../../../errors/AppError.js';
import { listModels } from '../modelRegistry.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  ModelDefinition,
  ProviderCredential,
  ValidationResult,
} from '../types.js';

export interface MockBehaviour {
  /** Force generate() to reject with this BuildMind error code. */
  failWith?: 'PROVIDER_TIMEOUT' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_AUTH_FAILED' | 'PROVIDER_UNAVAILABLE';
  /** Return malformed JSON, to exercise schema validation. */
  malformed?: boolean;
  /** Delay before answering, for cancellation and timeout tests. */
  delayMs?: number;
  /** Number of times to answer before failing; used to drive the fix loop. */
  failAfter?: number;
}

export class MockAIProvider implements AIProvider {
  public readonly id = 'mock';
  public readonly displayName = 'Mock (test only)';

  private behaviour: MockBehaviour = {};
  private calls = 0;

  /** Tests set this to shape the next responses. */
  setBehaviour(behaviour: MockBehaviour): void {
    this.behaviour = behaviour;
    this.calls = 0;
  }

  callCount(): number {
    return this.calls;
  }

  async validateCredentials(credential: ProviderCredential): Promise<ValidationResult> {
    if (!credential.apiKey.startsWith('sk-test-')) {
      return { valid: false, detail: 'Mock provider only accepts sk-test- keys.' };
    }
    return { valid: true, detail: 'Mock credential accepted.' };
  }

  async listModels(): Promise<ModelDefinition[]> {
    return listModels('openai');
  }

  async generate(_credential: ProviderCredential, request: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    const { failWith, malformed, delayMs, failAfter } = this.behaviour;

    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (request.signal?.aborted) throw new AppError('PROVIDER_TIMEOUT', { cause: 'aborted' });
    }

    if (failWith) throw new AppError(failWith, { cause: 'mock behaviour' });

    if (failAfter !== undefined && this.calls > failAfter) {
      // The first `failAfter` calls succeed; later ones fail. This lets a test
      // drive "fix loop runs out of attempts".
      throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: 'mock exhausted' });
    }

    if (malformed) {
      return { text: '{ "artifacts": [ this is not json', model: request.model, usage: { inputTokens: 1, outputTokens: 1 }, truncated: false };
    }

    return {
      text: this.responseFor(request),
      model: request.model,
      usage: { inputTokens: 10, outputTokens: 20 },
      truncated: false,
    };
  }

  /**
   * Canned but *shape-correct* responses. The build engine still validates
   * them against the real Zod schemas, so a schema regression fails a test.
   */
  private responseFor(request: GenerateRequest): string {
    const system = request.system.toLowerCase();

    if (system.includes('specification')) {
      return JSON.stringify({
        name: 'Test Arena',
        genre: 'arena',
        coreLoop: 'Players fight waves in a shrinking arena.',
        mechanics: ['melee combat', 'wave spawning'],
        systems: ['wave manager'],
        map: 'Arena floor',
        playerExperience: 'Fast, readable combat.',
        assets: [],
        scripts: ['Main.luau'],
        dependencies: [],
        validationRules: ['server script present'],
      });
    }

    if (system.includes('plan')) {
      return JSON.stringify({
        summary: 'Build a wave arena with one server script.',
        steps: [{ title: 'Create arena', detail: 'Floor and walls' }],
        files: ['Main.luau'],
      });
    }

    if (system.includes('fix')) {
      return JSON.stringify({
        diagnosis: 'Added the missing server script.',
        artifacts: [
          { path: 'Main.luau', type: 'script', content: '-- fixed\nprint("ok")', metadata: {} },
        ],
      });
    }

    // Default: a generation response.
    return JSON.stringify({
      artifacts: [
        { path: 'Main.luau', type: 'script', content: '-- BuildMind\nprint("hello")', metadata: {} },
        { path: 'README.md', type: 'doc', content: '# Test Arena', metadata: {} },
      ],
    });
  }
}
