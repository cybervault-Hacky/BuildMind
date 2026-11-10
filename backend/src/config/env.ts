/* ==========================================================================
   BuildMind API — config/env.ts
   Environment parsing and validation.

   Two rules drive this file:

     1. Fail at startup, not at request time. A missing DATABASE_URL should
        stop the process, not surface as a mystery 500 an hour later.
     2. Development may run with less than production. Production may not
        run with less than production.

   Nothing here logs a value. Errors name the variable, never its content.
   ========================================================================== */

import { z } from 'zod';

export type RuntimeMode = 'development' | 'test' | 'production';

const ModeSchema = z.enum(['development', 'test', 'production']);

/** A non-empty string that is not a known placeholder. */
const Required = (name: string) =>
  z
    .string()
    .min(1, `${name} must not be empty`)
    .refine((v) => !/^(changeme|placeholder|replace-me|your-.*-here)$/i.test(v), {
      message: `${name} still holds a placeholder value`,
    });

const Optional = z.string().min(1).optional();

const EnvSchema = z.object({
  NODE_ENV: ModeSchema.default('development'),
  // 0 is valid: it asks the OS for an ephemeral port (used by tests).
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  /** The frontend origin allowed to make credentialed requests. */
  APP_ORIGIN: z.string().url().default('http://localhost:8080'),

  DATABASE_URL: Required('DATABASE_URL'),

  /** Signs session cookies. Must be long and random in production. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  /** Wraps provider credentials at rest. Base64, 32 bytes decoded. */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded'),

  OPENAI_API_KEY: Optional,
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  GOOGLE_API_KEY: Optional,
  GOOGLE_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),

  ROBLOX_CLIENT_ID: Optional,
  ROBLOX_CLIENT_SECRET: Optional,
  ROBLOX_REDIRECT_URI: Optional,

  /** BuildMind-managed credentials: used when a user supplies no BYOK key. */
  MANAGED_OPENAI_API_KEY: Optional,
  MANAGED_GOOGLE_API_KEY: Optional,

  /** Where completed build workspaces are written. */
  WORKSPACE_ROOT: z.string().default('./.workspaces'),

  /** Trust proxy headers (only behind a known reverse proxy). */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  isTest: boolean;
  isDevelopment: boolean;
};

export class EnvError extends Error {
  public readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

/**
 * Parse and cross-validate the environment.
 * Throws EnvError listing every problem at once, so one restart reveals all.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = issue.path.join('.') || 'environment';
      return `${where}: ${issue.message}`;
    });
    throw new EnvError(problems);
  }

  const env = parsed.data;
  const problems: string[] = [];

  // Production is held to a higher standard than development.
  if (env.NODE_ENV === 'production') {
    if (env.SESSION_SECRET.length < 64) {
      problems.push('SESSION_SECRET: production requires at least 64 characters');
    }
    if (!env.APP_ORIGIN.startsWith('https://')) {
      problems.push('APP_ORIGIN: production requires an https:// origin');
    }
    if (source.ENCRYPTION_KEY && /^(.)\1+$/.test(Buffer.from(env.ENCRYPTION_KEY, 'base64').toString('hex'))) {
      problems.push('ENCRYPTION_KEY: appears to be a single repeated byte');
    }
  }

  // Roblox is all-or-nothing: a client id without a secret is a config bug.
  const robloxFields = [env.ROBLOX_CLIENT_ID, env.ROBLOX_CLIENT_SECRET, env.ROBLOX_REDIRECT_URI];
  const supplied = robloxFields.filter(Boolean).length;
  if (supplied > 0 && supplied < robloxFields.length) {
    problems.push(
      'ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET and ROBLOX_REDIRECT_URI must be set together or not at all',
    );
  }

  if (problems.length) throw new EnvError(problems);

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isDevelopment: env.NODE_ENV === 'development',
  };
}

/** True when BuildMind has its own provider credentials configured. */
export function hasManagedProviderKeys(env: Env): boolean {
  return Boolean(env.MANAGED_OPENAI_API_KEY || env.MANAGED_GOOGLE_API_KEY);
}
