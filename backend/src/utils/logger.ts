/* ==========================================================================
   BuildMind API — utils/logger.ts
   Structured JSON logs with a hard secret filter.

   Every value that reaches the log passes through `scrub`, which removes any
   string matching a known credential shape. This is defence in depth: the
   code should never log a key in the first place, and this makes a mistake
   inert rather than fatal.

   Fields are a fixed vocabulary (requestId, userId, buildId, runId, event,
   duration, result) so logs are queryable.
   ========================================================================== */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  event: string;
  requestId?: string;
  userId?: string;
  buildId?: string;
  runId?: string;
  method?: string;
  route?: string;
  status?: number;
  code?: string;
  duration?: number;
  result?: string;
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

/**
 * Patterns that indicate a credential. Deliberately broad: a false positive
 * costs a redacted log line, a false negative costs a leaked key.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
];

const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'apikey',
  'authorization',
  'password',
  'passwordhash',
  'token',
  'sessionsecret',
  'encryptionkey',
  'clientsecret',
  'secret',
  'cookie',
  'refreshtoken',
  'accesstoken',
  'ciphertext',
]);

function scrubString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : scrub(val, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  /** Buffered lines, so the test suite can assert nothing leaked. */
  private readonly buffer: string[] = [];

  private write(level: LogLevel, fields: LogFields): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.level)) return;

    const line = JSON.stringify({ level, time: new Date().toISOString(), ...(scrub(fields) as object) });
    this.buffer.push(line);
    if (this.buffer.length > 500) this.buffer.shift();
    // eslint-disable-next-line no-console
    process.stdout.write(`${line}\n`);
  }

  debug(fields: LogFields): void {
    this.write('debug', fields);
  }
  info(fields: LogFields): void {
    this.write('info', fields);
  }
  warn(fields: LogFields): void {
    this.write('warn', fields);
  }
  error(fields: LogFields): void {
    this.write('error', fields);
  }

  /** Everything logged so far, newest last. Used by the secret-leak suite. */
  lines(): string[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
