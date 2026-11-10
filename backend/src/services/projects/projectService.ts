/* ==========================================================================
   BuildMind API — services/projects/projectService.ts
   Project lifecycle, scoped to the authenticated user.

   Every method takes userId as a required parameter, and there is no code
   path that reads or writes a project without it. Ownership failures are
   reported as NOT_FOUND rather than FORBIDDEN: telling a stranger "you may
   not see this" confirms the resource exists.
   ========================================================================== */

import { notFound } from '../../errors/AppError.js';
import { ProjectRepository, type Project, type ProjectStatus } from '../../repositories/projects/projectRepository.js';
import type { Queryable } from '../../db/pool.js';

export interface PublicProject {
  id: string;
  name: string;
  description: string;
  prompt: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastBuildAt: string | null;
}

export function toPublicProject(project: Project): PublicProject {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    prompt: project.prompt,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    lastBuildAt: project.lastBuildAt ? project.lastBuildAt.toISOString() : null,
  };
}

export class ProjectService {
  private readonly repo: ProjectRepository;

  constructor(db: Queryable) {
    this.repo = new ProjectRepository(db);
  }

  async list(
    userId: string,
    options: { status?: ProjectStatus; search?: string; limit: number; cursor?: string },
  ): Promise<{ projects: PublicProject[]; nextCursor: string | null }> {
    const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString('utf8')) : 0;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

    // One extra row tells us whether another page exists, without a count().
    const rows = await this.repo.findManyByUser(userId, {
      ...(options.status ? { status: options.status } : {}),
      ...(options.search ? { search: options.search } : {}),
      limit: options.limit + 1,
      offset: safeOffset,
    });

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    return {
      projects: page.map(toPublicProject),
      nextCursor: hasMore ? Buffer.from(String(safeOffset + options.limit), 'utf8').toString('base64url') : null,
    };
  }

  /** Throws NOT_FOUND when the project is missing or owned by someone else. */
  async get(userId: string, id: string): Promise<PublicProject> {
    const project = await this.repo.findById(id, userId);
    if (!project) throw notFound();
    return toPublicProject(project);
  }

  async create(
    userId: string,
    input: { name: string; description?: string; prompt?: string },
  ): Promise<PublicProject> {
    const project = await this.repo.create({
      userId,
      name: input.name,
      description: input.description ?? '',
      prompt: input.prompt ?? '',
    });
    return toPublicProject(project);
  }

  async update(
    userId: string,
    id: string,
    patch: { name?: string; description?: string; prompt?: string },
  ): Promise<PublicProject> {
    const updated = await this.repo.update(id, userId, patch);
    if (!updated) throw notFound();
    return toPublicProject(updated);
  }

  async delete(userId: string, id: string): Promise<void> {
    const removed = await this.repo.delete(id, userId);
    if (!removed) throw notFound();
  }

  /**
   * Internal: used by the build orchestrator, which has already authorised the
   * build. Still scoped by userId.
   */
  async requireOwned(userId: string, id: string): Promise<Project> {
    const project = await this.repo.findById(id, userId);
    if (!project) throw notFound();
    return project;
  }

  async setStatus(userId: string, id: string, status: ProjectStatus): Promise<void> {
    await this.repo.update(id, userId, { status });
  }

  async markBuilt(userId: string, id: string, at: Date): Promise<void> {
    await this.repo.update(id, userId, { status: 'complete', lastBuildAt: at });
  }

  async count(userId: string): Promise<number> {
    return this.repo.countByUser(userId);
  }
}
