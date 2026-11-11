/* ==========================================================================
   BuildMind API — workspace/workspaceManager.ts
   Per-build isolated workspace on disk.

   Layout, keyed only by server-generated ids:

     <root>/<userId>/<buildId>/
         manifest.json      build metadata (ids, provider, model, timings)
         specification.json the validated GameSpecification
         plan.json          the validated BuildPlan
         scripts/  assets/  validation/
         result.json        terminal outcome and validation evidence

   Rules:
     * A user-supplied string never becomes a path component. `userId` and
       `buildId` are UUIDs, and both are re-validated here before use.
     * Every artifact path goes through safeJoin(), so the filesystem boundary
       holds even if the artifact validator were bypassed.
     * Deletion is scoped to a single build directory. Nothing recursive over
       the root is ever issued.
   ========================================================================== */

import { mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../errors/AppError.js';
import { safeJoin } from '../services/builds/artifactService.js';
import type { ValidatedArtifact } from '../services/builds/artifactService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new AppError('VALIDATION_ERROR', { fields: { [label]: 'Invalid identifier' } });
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  /** The directory for one build. Created on demand. */
  async ensure(userId: string, buildId: string): Promise<string> {
    assertUuid(userId, 'userId');
    assertUuid(buildId, 'buildId');
    const dir = join(this.root, userId, buildId);
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await mkdir(join(dir, 'assets'), { recursive: true });
    await mkdir(join(dir, 'validation'), { recursive: true });
    return dir;
  }

  /**
   * Write a JSON document that is not an artifact (manifest/spec/plan).
   * `name` may include one safe subdirectory (`validation/evidence.json`).
   * Every segment is checked, and safeJoin is still applied before writing.
   */
  async writeJson(userId: string, buildId: string, name: string, value: unknown): Promise<void> {
    const segments = name.split('/');
    const valid = segments.length <= 2 && segments.every((s) => /^[a-z0-9-]+(\.json)?$/i.test(s));
    if (!valid || !name.endsWith('.json')) {
      throw new AppError('VALIDATION_ERROR', { fields: { file: 'Invalid document name' } });
    }
    const dir = await this.ensure(userId, buildId);
    const target = safeJoin(dir, name);
    await mkdir(target.slice(0, target.lastIndexOf('/')) || dir, { recursive: true });
    await writeFile(target, JSON.stringify(value, null, 2), 'utf8');
  }

  /**
   * Persist validated artifacts. Paths are already shape-checked; safeJoin is
   * the enforcement point that touches disk.
   */
  async writeArtifacts(userId: string, buildId: string, artifacts: ValidatedArtifact[]): Promise<void> {
    const dir = await this.ensure(userId, buildId);
    for (const artifact of artifacts) {
      const target = safeJoin(dir, artifact.path);
      const parent = target.slice(0, target.lastIndexOf('/')) || dir;
      await mkdir(parent, { recursive: true });
      await writeFile(target, artifact.content, 'utf8');
    }
  }

  /** Remove exactly one build directory. */
  async remove(userId: string, buildId: string): Promise<void> {
    assertUuid(userId, 'userId');
    assertUuid(buildId, 'buildId');
    await rm(join(this.root, userId, buildId), { recursive: true, force: true });
  }

  /**
   * Retention: delete build directories older than `before`.
   * Only directories whose names are UUIDs are considered, so a stray file in
   * the workspace root can never be removed by this sweep.
   */
  async pruneBefore(before: Date): Promise<string[]> {
    const removed: string[] = [];
    let userDirs: string[] = [];
    try {
      userDirs = await readdir(this.root);
    } catch {
      return removed; // no workspace yet
    }

    for (const userDir of userDirs) {
      if (!UUID.test(userDir)) continue;
      const userPath = join(this.root, userDir);
      let buildDirs: string[] = [];
      try {
        buildDirs = await readdir(userPath);
      } catch {
        continue;
      }
      for (const buildDir of buildDirs) {
        if (!UUID.test(buildDir)) continue;
        const buildPath = join(userPath, buildDir);
        try {
          const info = await stat(buildPath);
          if (info.mtime < before) {
            await rm(buildPath, { recursive: true, force: true });
            removed.push(`${userDir}/${buildDir}`);
          }
        } catch {
          // Vanished between readdir and stat: already gone, nothing to do.
        }
      }
    }
    return removed;
  }
}
