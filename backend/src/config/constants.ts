/* ==========================================================================
   BuildMind API — config/constants.ts
   Numbers that bound the system. Every limit here is enforced somewhere; a
   constant nobody reads would be a lie, so each one has a named owner:

     PROMPT_*            → validation/buildSchemas.ts
     MAX_*_ARTIFACT      → services/builds/artifactService.ts
     MAX_FIX_ATTEMPTS    → services/builds/buildOrchestrator.ts
     buildTimeoutMs      → services/builds/buildOrchestrator.ts
     SESSION_TTL_MS      → services/auth/authService.ts
   ========================================================================== */

export const API_PREFIX = '/api/v1';

/** Prompt length bounds, in characters, after trimming. */
export const PROMPT_MIN = 8;
export const PROMPT_MAX = 4000;

/** Project field bounds. */
export const PROJECT_NAME_MAX = 60;
export const PROJECT_DESCRIPTION_MAX = 280;

/** Generated-artifact bounds. Enforced before anything is written to disk. */
export const MAX_ARTIFACTS = 40;
export const MAX_ARTIFACT_BYTES = 128 * 1024;
export const MAX_TOTAL_ARTIFACT_BYTES = 1024 * 1024;

/** Build orchestration bounds. */
export const MAX_FIX_ATTEMPTS = 2;
export const MAX_CONCURRENT_BUILDS_PER_USER = 2;
export const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

/** Provider-call bounds. */
export const PROVIDER_TIMEOUT_MS = 60 * 1000;
export const PROVIDER_VALIDATE_TIMEOUT_MS = 15 * 1000;
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Session lifetime: 7 days absolute, sliding on use. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Request body ceiling for the whole API (fastify bodyLimit). */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Workspace retention: completed builds are pruned after this age. */
export const WORKSPACE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Build-event retention. */
export const BUILD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Studio bridge protocol. */
export const STUDIO_PROTOCOL_VERSION = 1;
export const STUDIO_SESSION_TTL_MS = 30 * 60 * 1000;
export const STUDIO_NONCE_TTL_MS = 5 * 60 * 1000;
