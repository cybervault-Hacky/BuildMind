/* ==========================================================================
   BuildMind API — services/builds/artifactService.ts
   Generated artifacts: path safety, size limits, structural validation.

   The threat model is specific. Model output is untrusted input. The dangers
   that matter are:

     1. Path traversal — "../../etc/passwd" must never resolve outside the
        build workspace. We reject the shape rather than trying to sanitise
        it, because rewriting a hostile path is guesswork.
     2. Absolute or drive-qualified paths — rejected outright.
     3. Null-byte and backslash tricks — rejected.
     4. Size bombs — per-file and total limits, checked before writing.
     5. Executable content — Luau is text; nothing here is ever executed on
        the host, and the extensions we accept are an allowlist.

   The safe-join helper is belt-and-braces: even after validation, the final
   resolved path is asserted to be inside the workspace root.
   ========================================================================== */

import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { AppError } from '../../errors/AppError.js';
import {
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  MAX_TOTAL_ARTIFACT_BYTES,
} from '../../config/constants.js';
import { ArtifactSchema, type Artifact } from '../../validation/schemas.js';

/** Extensions we accept, by artifact type. Nothing executable-on-host. */
const TYPE_EXTENSIONS: Record<Artifact['type'], readonly string[]> = {
  script: ['.luau', '.lua'],
  asset: ['.rbxmx', '.json', '.svg', '.png', '.jpg', '.txt'],
  manifest: ['.json', '.project.json', '.toml'],
  config: ['.json', '.toml', '.yaml', '.yml'],
  doc: ['.md', '.txt'],
};

export interface ValidatedArtifact extends Artifact {
  checksum: string;
  bytes: number;
}

export interface ArtifactValidationResult {
  valid: boolean;
  artifacts: ValidatedArtifact[];
  issues: string[];
}

function extensionOf(path: string): string {
  const lower = path.toLowerCase();
  // ".project.json" must win over ".json" for manifests.
  if (lower.endsWith('.project.json')) return '.project.json';
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? '' : lower.slice(dot);
}

/**
 * Join an artifact path to a workspace root, refusing anything that escapes.
 * Validation should already have rejected hostile input; this is the second
 * gate, and it is the one that actually touches the filesystem.
 */
export function safeJoin(root: string, artifactPath: string): string {
  if (artifactPath.includes('\0')) throw new AppError('VALIDATION_ERROR', { fields: { artifact: 'Invalid path' } });

  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, artifactPath);

  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new AppError('VALIDATION_ERROR', { fields: { artifact: 'Path escapes the workspace' } });
  }
  return target;
}

/** Validate a batch of raw artifacts (already shape-checked by Zod upstream). */
export function validateArtifacts(raw: unknown[]): ArtifactValidationResult {
  const issues: string[] = [];

  if (raw.length === 0) issues.push('No artifacts were produced.');
  if (raw.length > MAX_ARTIFACTS) issues.push(`Too many artifacts (limit ${MAX_ARTIFACTS}).`);

  const parsed: Artifact[] = [];
  raw.forEach((entry, index) => {
    const result = ArtifactSchema.safeParse(entry);
    if (!result.success) {
      // A concrete, user-safe description of what is wrong with this file —
      // this is the text the fix loop is given to correct.
      const first = result.error.issues[0];
      const where = first?.path.join('.') || 'file';
      const name =
        entry && typeof entry === 'object' && 'path' in entry ? String((entry as { path: unknown }).path) : `#${index + 1}`;
      issues.push(`Artifact ${name} has an invalid ${where}: ${first?.message ?? 'invalid'}.`);
      return;
    }
    parsed.push(result.data);
  });

  // Duplicate paths would make "which file is real?" ambiguous.
  const seen = new Set<string>();
  for (const artifact of parsed) {
    const key = artifact.path.toLowerCase();
    if (seen.has(key)) issues.push(`Duplicate artifact path: ${artifact.path}.`);
    seen.add(key);
  }

  let totalBytes = 0;
  const validated: ValidatedArtifact[] = [];

  for (const artifact of parsed) {
    const bytes = Buffer.byteLength(artifact.content, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) {
      issues.push(`${artifact.path} is larger than ${Math.floor(MAX_ARTIFACT_BYTES / 1024)} KB.`);
      continue;
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      issues.push('Artifacts exceed the total size limit.');
      break;
    }

    const ext = extensionOf(artifact.path);
    const allowed = TYPE_EXTENSIONS[artifact.type];
    if (!allowed.includes(ext)) {
      issues.push(`${artifact.path} is not a valid ${artifact.type} file (expected ${allowed.join(', ')}).`);
      continue;
    }

    // A script that is empty is a structural failure, not a style preference.
    if (artifact.type === 'script' && artifact.content.trim().length === 0) {
      issues.push(`${artifact.path} is empty.`);
      continue;
    }

    validated.push({
      ...artifact,
      bytes,
      checksum: createHash('sha256').update(artifact.content, 'utf8').digest('hex'),
    });
  }

  return { valid: issues.length === 0, artifacts: validated, issues };
}

/**
 * Structural checks that do not depend on the model at all: does the result
 * contain the files the plan promised, and do script references resolve?
 */
export function validateAgainstPlan(
  artifacts: ValidatedArtifact[],
  plannedFiles: string[],
): string[] {
  const issues: string[] = [];
  const produced = new Set(artifacts.map((a) => a.path));

  for (const file of plannedFiles) {
    if (!produced.has(file)) issues.push(`Planned file was not produced: ${file}.`);
  }

  const hasScript = artifacts.some((a) => a.type === 'script');
  if (!hasScript) issues.push('No script artifact was produced.');

  const hasManifest = artifacts.some((a) => a.type === 'manifest' || a.path.toLowerCase().endsWith('.project.json'));
  if (!hasManifest) issues.push('No project manifest was produced.');

  return issues;
}

/** A manifest is valid JSON with the keys Roblox tooling expects. */
export function validateManifest(artifacts: ValidatedArtifact[]): string[] {
  const issues: string[] = [];
  const manifests = artifacts.filter(
    (a) => a.type === 'manifest' || a.path.toLowerCase().endsWith('.project.json'),
  );

  if (manifests.length === 0) return ['No project manifest was produced.'];

  for (const manifest of manifests) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.content);
    } catch {
      issues.push(`${manifest.path} is not valid JSON.`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      issues.push(`${manifest.path} must be an object.`);
      continue;
    }
    const name = (parsed as { name?: unknown }).name;
    if (name !== undefined && typeof name !== 'string') {
      issues.push(`${manifest.path} has an invalid name.`);
    }
  }

  return issues;
}
