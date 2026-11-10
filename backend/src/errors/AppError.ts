/* ==========================================================================
   BuildMind API — errors/AppError.ts
   One error type, one safe public shape.

   Every failure that reaches a client is an AppError. Anything else is a bug
   and is reported to the client as INTERNAL_ERROR with no detail, while the
   real cause is logged server-side against the request id.

   `code` is a stable machine string; `message` is user-safe copy. Nothing
   here ever carries a stack, SQL, path or credential.
   ========================================================================== */

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_INVALID_OUTPUT: 'PROVIDER_INVALID_OUTPUT',
  BUILD_FAILED: 'BUILD_FAILED',
  BUILD_CANCELLED: 'BUILD_CANCELLED',
  BUILD_CONFLICT: 'BUILD_CONFLICT',
  BUILD_TIMEOUT: 'BUILD_TIMEOUT',
  VALIDATION_INCOMPLETE: 'VALIDATION_INCOMPLETE',
  ROBLOX_UNAVAILABLE: 'ROBLOX_UNAVAILABLE',
  ROBLOX_NOT_CONFIGURED: 'ROBLOX_NOT_CONFIGURED',
  STUDIO_UNAVAILABLE: 'STUDIO_UNAVAILABLE',
  STUDIO_UNAUTHORIZED: 'STUDIO_UNAUTHORIZED',
  STUDIO_PROTOCOL_ERROR: 'STUDIO_PROTOCOL_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** HTTP status per code. Codes not listed fall back to 500. */
const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  CONFIGURATION_ERROR: 500,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_AUTH_FAILED: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_INVALID_OUTPUT: 502,
  BUILD_FAILED: 409,
  BUILD_CANCELLED: 409,
  BUILD_CONFLICT: 409,
  BUILD_TIMEOUT: 409,
  VALIDATION_INCOMPLETE: 409,
  ROBLOX_UNAVAILABLE: 503,
  ROBLOX_NOT_CONFIGURED: 501,
  STUDIO_UNAVAILABLE: 503,
  STUDIO_UNAUTHORIZED: 401,
  STUDIO_PROTOCOL_ERROR: 400,
  INTERNAL_ERROR: 500,
};

/** User-facing copy per code. Never technical, never revealing. */
const SAFE_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Some details need attention.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: 'You do not have access to that.',
  NOT_FOUND: 'That item could not be found.',
  CONFLICT: 'That change conflicts with the current state.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
  PAYLOAD_TOO_LARGE: 'That request is too large.',
  CONFIGURATION_ERROR: 'The server is not configured for that operation.',
  PROVIDER_UNAVAILABLE: 'The AI provider is not reachable right now.',
  PROVIDER_AUTH_FAILED: 'The AI provider rejected those credentials.',
  PROVIDER_TIMEOUT: 'The AI provider took too long to respond.',
  PROVIDER_RATE_LIMITED: 'The AI provider is rate limiting this account.',
  PROVIDER_INVALID_OUTPUT: 'The AI provider returned something unusable.',
  BUILD_FAILED: 'The build did not complete.',
  BUILD_CANCELLED: 'The build was cancelled.',
  BUILD_CONFLICT: 'This build has already changed state.',
  BUILD_TIMEOUT: 'The build ran out of time.',
  VALIDATION_INCOMPLETE: 'The build finished without passing validation.',
  ROBLOX_UNAVAILABLE: 'Roblox is not reachable right now.',
  ROBLOX_NOT_CONFIGURED: 'Roblox integration is not configured on this server.',
  STUDIO_UNAVAILABLE: 'No Studio session is connected.',
  STUDIO_UNAUTHORIZED: 'That Studio session is not authorized.',
  STUDIO_PROTOCOL_ERROR: 'The Studio message was not understood.',
  INTERNAL_ERROR: 'Something went wrong.',
};

export interface AppErrorOptions {
  /** Field-level detail for VALIDATION_ERROR. Never contains secrets. */
  fields?: Record<string, string>;
  /** Extra safe, client-visible detail (e.g. build status). */
  detail?: Record<string, unknown>;
  /** Original error, for server-side logging only. Never serialised. */
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly fields?: Record<string, string>;
  public readonly detail?: Record<string, unknown>;
  public override readonly cause?: unknown;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(SAFE_MESSAGE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    if (options.fields) this.fields = options.fields;
    if (options.detail) this.detail = options.detail;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** The only shape that may cross the network boundary for a failure. */
  toPublic(): { ok: false; error: { code: ErrorCode; message: string; fields?: Record<string, string>; detail?: Record<string, unknown> } } {
    const error: { code: ErrorCode; message: string; fields?: Record<string, string>; detail?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    };
    if (this.fields) error.fields = this.fields;
    if (this.detail) error.detail = this.detail;
    return { ok: false, error };
  }
}

/* Shorthands for the common cases. */
export const unauthenticated = (cause?: unknown) => new AppError('UNAUTHENTICATED', { cause });
export const forbidden = (cause?: unknown) => new AppError('FORBIDDEN', { cause });
/** Ownership failures are reported as NOT_FOUND so existence is not confirmed. */
export const notFound = (cause?: unknown) => new AppError('NOT_FOUND', { cause });
export const validationError = (fields: Record<string, string>) =>
  new AppError('VALIDATION_ERROR', { fields });
export const conflict = (code: ErrorCode = 'CONFLICT', cause?: unknown) => new AppError(code, { cause });
