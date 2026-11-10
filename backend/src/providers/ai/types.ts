/* ==========================================================================
   BuildMind API — providers/ai/types.ts
   The AIProvider contract.

   Controllers and the build orchestrator only ever see this interface. No
   OpenAI- or Gemini-shaped field crosses it: provider dialects are normalised
   inside each adapter, which is what makes adding a provider a registry edit
   rather than a build-engine rewrite.

   Every method rejects with an AppError carrying a BuildMind error code, so
   callers never branch on an HTTP status from a vendor.
   ========================================================================== */

export interface ProviderCredential {
  /** The secret itself. Never logged, never stored, never echoed. */
  apiKey: string;
  /** 'byok' when the user supplied it, 'managed' when BuildMind pays. */
  source: 'byok' | 'managed';
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  provider: string;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  contextLimit: number;
  /** Rough output ceiling we will accept from this model. */
  maxOutputTokens: number;
}

export interface GenerateRequest {
  model: string;
  system: string;
  user: string;
  /** Ask for JSON. Adapters map this to the provider's own mechanism. */
  json: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** True when the provider reported truncation; callers must treat as invalid. */
  truncated: boolean;
}

export interface ValidationResult {
  valid: boolean;
  /** Which model the provider actually accepted, when it tells us. */
  model?: string;
  /** Safe detail for the UI; never raw provider text on failure. */
  detail?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;

  /**
   * Confirm the credential works. This must make a real provider request —
   * a UI may only show "Valid" after this resolves valid: true.
   */
  validateCredentials(credential: ProviderCredential, signal?: AbortSignal): Promise<ValidationResult>;

  /** Models this account can actually use, filtered to our registry. */
  listModels(credential: ProviderCredential, signal?: AbortSignal): Promise<ModelDefinition[]>;

  /** Single, non-streaming generation. Structured output validated by caller. */
  generate(credential: ProviderCredential, request: GenerateRequest): Promise<GenerateResult>;
}

export interface ProviderStatus {
  id: string;
  displayName: string;
  requiresKey: boolean;
  /** True when BuildMind itself holds a credential for this provider. */
  managedAvailable: boolean;
  models: ModelDefinition[];
  /** Populated when the provider cannot be used at all (e.g. not configured). */
  unavailableReason?: string;
}
