/* ==========================================================================
   BuildMind API — validation/schemas.ts
   Every request boundary validates here. Nothing reaches a service without
   having passed one of these schemas.

   Rationale for a few non-obvious choices:
     * `.strict()` on objects: an unknown field is rejected rather than
       silently dropped, so a client cannot smuggle `userId` or `status`
       past validation and hope it rides along into a query.
     * ids are UUIDs, not "some string", so a malformed id cannot reach SQL.
     * prompts are bounded at both ends; an unbounded prompt is a cost vector.
   ========================================================================== */

import { z } from 'zod';
import {
  MAX_ARTIFACTS,
  PROMPT_MAX,
  PROMPT_MIN,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
} from '../config/constants.js';

export const Uuid = z.string().uuid('Must be a valid id');

/** Email: normalised to lowercase before it ever reaches a repository. */
export const Email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

/**
 * Password policy: length is the dominant factor, so we require 12 characters
 * and a sane maximum (a hash input that cannot blow up scrypt).
 */
export const Password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200, 'Use at most 200 characters');

export const DisplayName = z.string().trim().min(1, 'Add a name').max(80);

export const RegisterSchema = z
  .object({
    email: Email,
    password: Password,
    displayName: DisplayName.optional(),
  })
  .strict();

export const LoginSchema = z
  .object({
    email: Email,
    password: z.string().min(1).max(200),
  })
  .strict();

/** Provider identifiers are an enum: an unknown provider never reaches code. */
export const ProviderId = z.enum(['openai', 'google']);

export const Prompt = z.string().trim().min(PROMPT_MIN, 'Describe the game in a sentence').max(PROMPT_MAX);

export const ProjectName = z.string().trim().min(1, 'Add a name').max(PROJECT_NAME_MAX);
export const ProjectDescription = z.string().trim().max(PROJECT_DESCRIPTION_MAX).default('');

export const CreateProjectSchema = z
  .object({
    name: ProjectName,
    description: ProjectDescription.optional(),
    prompt: z.string().trim().max(PROMPT_MAX).optional(),
  })
  .strict();

export const UpdateProjectSchema = z
  .object({
    name: ProjectName.optional(),
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).optional(),
    prompt: z.string().trim().max(PROMPT_MAX).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const ListProjectsSchema = z
  .object({
    status: z
      .enum(['draft', 'ready', 'building', 'testing', 'fixing', 'validating', 'complete', 'stopped', 'error'])
      .optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const CreateBuildSchema = z
  .object({
    projectId: Uuid,
    prompt: Prompt.optional(),
    provider: ProviderId,
    model: z.string().trim().min(1).max(80),
    /** BYOK key. Accepted in the body over HTTPS, never in a query string. */
    apiKey: z.string().min(8).max(4096).optional(),
  })
  .strict();

export const ListBuildsSchema = z
  .object({
    projectId: Uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const EventsQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const ValidateProviderSchema = z
  .object({
    provider: ProviderId,
    model: z.string().trim().min(1).max(80).optional(),
    apiKey: z.string().min(8).max(4096).optional(),
  })
  .strict();

export const ProviderModelsSchema = z
  .object({
    provider: ProviderId,
  })
  .strict();

/** Roblox OAuth: the code and state come back from the provider, not the user. */
export const RobloxConnectSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(256),
  })
  .strict();

/**
 * Studio bridge message envelope. Every field is required and the message
 * type is an allowlist, so an unknown message is rejected at the edge.
 */
export const StudioMessageSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionId: Uuid,
    buildId: Uuid,
    runId: Uuid,
    messageType: z.enum([
      'hello',
      'delivery_started',
      'delivery_progress',
      'delivery_complete',
      'delivery_failed',
      'validation_started',
      'validation_complete',
      'validation_failed',
    ]),
    payload: z.record(z.string(), z.unknown()).default({}),
    timestamp: z.coerce.number().int(),
    nonce: z.string().min(8).max(128),
  })
  .strict();

/** Artifact path rules live in one place so both generation and validation use them. */
export const ArtifactPath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/'), { message: 'Absolute paths are not allowed' })
  .refine((p) => !/^[A-Za-z]:[\\/]/.test(p), { message: 'Drive-qualified paths are not allowed' })
  .refine((p) => !p.includes('\\'), { message: 'Backslashes are not allowed' })
  .refine((p) => !p.split('/').includes('..'), { message: 'Parent segments are not allowed' })
  .refine((p) => !p.includes('\0'), { message: 'Null bytes are not allowed' })
  .refine((p) => !/\/\//.test(p), { message: 'Empty path segments are not allowed' })
  .refine((p) => /^[A-Za-z0-9._/-]+$/.test(p), { message: 'Only letters, digits, dot, dash, underscore and slash' });

export const ArtifactSchema = z
  .object({
    path: ArtifactPath,
    type: z.enum(['script', 'asset', 'manifest', 'config', 'doc']),
    content: z.string().max(128 * 1024),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const ArtifactListSchema = z.array(ArtifactSchema).max(MAX_ARTIFACTS);

/**
 * Model output is validated in two stages, deliberately.
 *
 * This schema only checks the *envelope* — that each entry looks like an
 * artifact at all. Path safety and type allowlisting happen in
 * artifactService.validateArtifacts(), which reports **issues** rather than
 * throwing. That ordering is what lets the fix loop repair an unsafe path
 * instead of failing the build outright.
 */
export const RawArtifactSchema = z
  .object({
    path: z.string().min(1).max(400),
    type: z.string().min(1).max(40),
    content: z.string().max(256 * 1024),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export const RawArtifactListSchema = z.array(RawArtifactSchema).max(MAX_ARTIFACTS * 2);

/** Structured AI output contract — validated before anything executes. */
export const GameSpecificationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    genre: z.string().trim().min(1).max(60),
    coreLoop: z.string().trim().min(1).max(400),
    mechanics: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
    systems: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    map: z.string().trim().max(600).default(''),
    playerExperience: z.string().trim().max(600).default(''),
    assets: z.array(z.string().trim().max(120)).max(40).default([]),
    scripts: z.array(z.string().trim().max(120)).max(40).default([]),
    dependencies: z.array(z.string().trim().max(120)).max(40).default([]),
    validationRules: z.array(z.string().trim().max(200)).max(40).default([]),
  })
  .strict();

export const BuildPlanSchema = z
  .object({
    summary: z.string().trim().min(1).max(600),
    steps: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            detail: z.string().trim().max(400).default(''),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    files: z.array(ArtifactPath).max(MAX_ARTIFACTS).default([]),
  })
  .strict();

export const GenerationSchema = z
  .object({
    artifacts: RawArtifactListSchema.min(1),
  })
  .strict();

export const FixPlanSchema = z
  .object({
    diagnosis: z.string().trim().min(1).max(600),
    artifacts: RawArtifactListSchema.min(1),
  })
  .strict();

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type ListProjectsInput = z.infer<typeof ListProjectsSchema>;
export type CreateBuildInput = z.infer<typeof CreateBuildSchema>;
export type ValidateProviderInput = z.infer<typeof ValidateProviderSchema>;
export type StudioMessage = z.infer<typeof StudioMessageSchema>;
export type GameSpecification = z.infer<typeof GameSpecificationSchema>;
export type BuildPlan = z.infer<typeof BuildPlanSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
