/* ==========================================================================
   BuildMind API — repositories/projects/projectRepository.ts
   Every method takes userId and every statement filters on it. There is
   deliberately no `findById(id)` without an owner: the query boundary is the
   last line of defence against IDOR if a service forgets a check.

   update/delete return the affected row (or null), so a caller cannot mistake
   "no rows changed because it is not yours" for success.
   ========================================================================== */

import type { Queryable } from '../../db/pool.js';

export type ProjectStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'building'
  | 'testing'
  | 'fixing'
  | 'validating'
  | 'complete'
  | 'stopped'
  | 'error';

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string;
  prompt: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
  lastBuildAt: Date | null;
}

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  prompt: string;
  status: ProjectStatus;
  created_at: Date;
  updated_at: Date;
  last_build_at: Date | null;
}

const COLUMNS = `id, user_id, name, description, prompt, status, created_at, updated_at, last_build_at`;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastBuildAt: row.last_build_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string, userId: string): Promise<Project | null> {
    const res = await this.db.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = res.rows[0];
    return row ? toProject(row) : null;
  }

  async findManyByUser(
    userId: string,
    options: { status?: ProjectStatus; search?: string; limit: number; offset: number },
  ): Promise<Project[]> {
    const res = await this.db.query<ProjectRow>(
      `SELECT ${COLUMNS}
         FROM projects
        WHERE user_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR description ILIKE '%' || $3 || '%')
        ORDER BY updated_at DESC
        LIMIT $4 OFFSET $5`,
      [userId, options.status ?? null, options.search ?? null, options.limit, options.offset],
    );
    return res.rows.map(toProject);
  }

  async countByUser(userId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM projects WHERE user_id = $1`, [
      userId,
    ]);
    return Number(res.rows[0]?.count ?? '0');
  }

  async create(input: {
    userId: string;
    name: string;
    description: string;
    prompt: string;
    id?: string;
  }): Promise<Project> {
    const res = await this.db.query<ProjectRow>(
      `INSERT INTO projects (id, user_id, name, description, prompt)
            VALUES (COALESCE($5::uuid, gen_random_uuid()), $1, $2, $3, $4)
         RETURNING ${COLUMNS}`,
      [input.userId, input.name, input.description, input.prompt, input.id ?? null],
    );
    const row = res.rows[0];
    if (!row) throw new Error('project insert returned no row');
    return toProject(row);
  }

  async update(
    id: string,
    userId: string,
    patch: { name?: string; description?: string; prompt?: string; status?: ProjectStatus; lastBuildAt?: Date },
  ): Promise<Project | null> {
    const res = await this.db.query<ProjectRow>(
      `UPDATE projects
          SET name          = COALESCE($3, name),
              description   = COALESCE($4, description),
              prompt        = COALESCE($5, prompt),
              status        = COALESCE($6, status),
              last_build_at = COALESCE($7, last_build_at),
              updated_at    = now()
        WHERE id = $1 AND user_id = $2
    RETURNING ${COLUMNS}`,
      [
        id,
        userId,
        patch.name ?? null,
        patch.description ?? null,
        patch.prompt ?? null,
        patch.status ?? null,
        patch.lastBuildAt ?? null,
      ],
    );
    const row = res.rows[0];
    return row ? toProject(row) : null;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (res.rowCount ?? 0) > 0;
  }
}
