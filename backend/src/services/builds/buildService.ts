/* ==========================================================================
   BuildMind API — services/builds/buildService.ts
   Build creation, lookup, cancellation and retry.

   This is the application layer the controllers talk to. It owns:

     * authorisation — the user comes from the session, never the body
     * the per-user concurrency cap and the "one active build per project" rule
     * cancellation: mark the row, abort the provider call, let the
       orchestrator observe it and write the terminal state
     * retry: a NEW build row with a NEW runId, linked via retry_of. The old
       build and its events are untouched, so a retry can never be repainted
       by the previous run.
   ========================================================================== */

import { AppError, notFound } from '../../errors/AppError.js';
import { BuildRepository, type Build, type BuildEvent } from '../../repositories/builds/buildRepository.js';
import { ProjectRepository } from '../../repositories/projects/projectRepository.js';
import { BuildOrchestrator, type BuildJob } from './buildOrchestrator.js';
import { ACTIVE_STATUSES, isTerminal, type BuildStatus } from './stateMachine.js';
import { MAX_CONCURRENT_BUILDS_PER_USER } from '../../config/constants.js';
import { isModelForProvider } from '../../providers/ai/modelRegistry.js';
import type { CredentialService } from '../ai/credentialService.js';
import type { Queryable } from '../../db/pool.js';

export interface PublicBuild {
  id: string;
  projectId: string;
  runId: string;
  status: BuildStatus;
  currentStage: string | null;
  progress: number;
  provider: string;
  model: string;
  retryOf: string | null;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicBuild(build: Build): PublicBuild {
  return {
    id: build.id,
    projectId: build.projectId,
    runId: build.runId,
    status: build.status,
    currentStage: build.currentStage,
    progress: build.progress,
    provider: build.provider,
    model: build.model,
    retryOf: build.retryOf,
    startedAt: build.startedAt ? build.startedAt.toISOString() : null,
    endedAt: build.endedAt ? build.endedAt.toISOString() : null,
    errorCode: build.errorCode,
    errorMessageSafe: build.errorMessageSafe,
    createdAt: build.createdAt.toISOString(),
    updatedAt: build.updatedAt.toISOString(),
  };
}

export interface PublicBuildEvent {
  seq: number;
  stage: string | null;
  status: string;
  progress: number;
  activity: string;
  timestamp: string;
}

export class BuildService {
  private readonly builds: BuildRepository;
  private readonly projects: ProjectRepository;
  /** Per-user create queue so concurrent submissions never race the active cap. */
  private readonly createLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Queryable,
    private readonly orchestrator: BuildOrchestrator,
    private readonly credentials: CredentialService,
  ) {
    this.builds = new BuildRepository(db);
    this.projects = new ProjectRepository(db);
  }

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.createLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.createLocks.set(userId, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.createLocks.get(userId) === tail) {
        this.createLocks.delete(userId);
      }
    }
  }

  /** Create a build and start it in the background. Returns immediately. */
  async create(
    userId: string,
    input: { projectId: string; prompt?: string; provider: string; model: string; apiKey?: string },
    options: { retryOf?: string } = {},
  ): Promise<PublicBuild> {
    return this.withUserLock(userId, () => this.createUnlocked(userId, input, options));
  }

  private async createUnlocked(
    userId: string,
    input: { projectId: string; prompt?: string; provider: string; model: string; apiKey?: string },
    options: { retryOf?: string } = {},
  ): Promise<PublicBuild> {
    const project = await this.projects.findById(input.projectId, userId);
    if (!project) throw notFound();

    // Server-side model/provider pairing check. The client cannot choose a
    // combination the registry does not contain.
    if (!isModelForProvider(input.provider, input.model)) {
      throw new AppError('VALIDATION_ERROR', { fields: { model: 'That model is not available for this provider.' } });
    }

    const prompt = (input.prompt ?? project.prompt ?? '').trim();
    if (prompt.length < 8) {
      throw new AppError('VALIDATION_ERROR', { fields: { prompt: 'Describe the game in a sentence.' } });
    }

    // One active build per project: a second click must not fork the project.
    const existing = await this.builds.findManyByUser(userId, { projectId: input.projectId, limit: 5 });
    if (existing.some((b) => !isTerminal(b.status)) && !options.retryOf) {
      throw new AppError('BUILD_CONFLICT', { fields: { build: 'This project already has a build running.' } });
    }

    const activeCount = await this.builds.countActiveByUser(userId);
    if (activeCount >= MAX_CONCURRENT_BUILDS_PER_USER) {
      throw new AppError('BUILD_CONFLICT', { fields: { build: 'You have too many builds running at once.' } });
    }

    // A build without a usable credential would fail later with a confusing
    // provider error. Refuse now, with the reason.
    const credential = await this.credentials.resolve(userId, input.provider, input.apiKey);
    if (!credential) {
      // A missing *user* credential is an input problem (4xx), not a server
      // misconfiguration (5xx): the user can fix it by supplying a key.
      throw new AppError('VALIDATION_ERROR', {
        fields: { apiKey: 'Add a provider key to run a build.' },
      });
    }

    // Store a supplied key before starting, so a retry later in the session
    // still works without the client resending it.
    if (input.apiKey) await this.credentials.store(userId, input.provider, input.apiKey);

    let build: Build;
    try {
      build = await this.builds.create({
        projectId: input.projectId,
        userId,
        provider: input.provider,
        model: input.model,
        ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '23505') {
        throw new AppError('BUILD_CONFLICT', { fields: { build: 'This project already has a build running.' } });
      }
      throw err;
    }

    await this.projects.update(input.projectId, userId, {
      prompt,
      status: 'queued',
    });

    const job: BuildJob = {
      buildId: build.id,
      userId,
      projectId: input.projectId,
      prompt,
      provider: input.provider,
      model: input.model,
      credential,
    };

    // Deliberately not awaited: the HTTP response returns buildId/runId and
    // the client follows the event stream. Errors are caught inside run().
    void this.orchestrator.run(job);

    return toPublicBuild(build);
  }

  async get(userId: string, id: string): Promise<PublicBuild> {
    const build = await this.builds.findById(id, userId);
    if (!build) throw notFound();
    return toPublicBuild(build);
  }

  async list(userId: string, options: { projectId?: string; limit: number }): Promise<PublicBuild[]> {
    const builds = await this.builds.findManyByUser(userId, options);
    return builds.map(toPublicBuild);
  }

  /**
   * Cancel a build.
   *
   * Order matters: the request is persisted first (so the orchestrator sees
   * it at its next checkpoint), then the provider call is aborted. The
   * orchestrator writes the terminal state; if it has already finished, the
   * build is simply returned as-is and the caller sees a conflict.
   */
  async cancel(userId: string, id: string): Promise<PublicBuild> {
    const build = await this.builds.findById(id, userId);
    if (!build) throw notFound();
    if (isTerminal(build.status)) {
      throw new AppError('BUILD_CONFLICT', { detail: { status: build.status } });
    }

    const requested = await this.builds.requestCancel(id, userId);
    this.orchestrator.abort(id);

    const current = await this.builds.findById(id, userId);
    return toPublicBuild(current ?? requested ?? build);
  }

  /** Retry: a new build row and a new runId; the old build is left intact. */
  async retry(
    userId: string,
    id: string,
    options: { apiKey?: string } = {},
  ): Promise<PublicBuild> {
    const previous = await this.builds.findById(id, userId);
    if (!previous) throw notFound();

    if (!isTerminal(previous.status)) {
      throw new AppError('BUILD_CONFLICT', { fields: { build: 'That build is still running.' } });
    }

    return this.create(
      userId,
      {
        projectId: previous.projectId,
        provider: previous.provider,
        model: previous.model,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      },
      { retryOf: id },
    );
  }

  /** Events for the current run of a build. Old runs never leak in. */
  async events(userId: string, id: string, after: number): Promise<{ events: PublicBuildEvent[]; runId: string }> {
    const build = await this.builds.findById(id, userId);
    if (!build) throw notFound();

    const rows: BuildEvent[] = await this.builds.listEvents(id, userId, build.runId, after);
    return {
      runId: build.runId,
      events: rows.map((e) => ({
        seq: e.seq,
        stage: e.stage,
        status: e.status,
        progress: e.progress,
        activity: e.activity,
        timestamp: e.createdAt.toISOString(),
      })),
    };
  }

  /** The run id a live subscriber should bind to. */
  async currentRunId(userId: string, id: string): Promise<{ build: PublicBuild; runId: string }> {
    const build = await this.builds.findById(id, userId);
    if (!build) throw notFound();
    return { build: toPublicBuild(build), runId: build.runId };
  }

  /** Cleanup: builds whose run died without writing a terminal state. */
  async failAbandoned(olderThan: Date): Promise<number> {
    // Nothing to do in-process: the orchestrator's timeout always writes a
    // terminal state. This exists so a multi-process deployment can reap rows
    // left behind by a crashed worker.
    const res = await this.db.query(
      `UPDATE builds
          SET status = 'failed',
              error_code = 'BUILD_TIMEOUT',
              error_message_safe = 'The build ran out of time.',
              ended_at = now(),
              updated_at = now()
        WHERE status = ANY($1::text[])
          AND updated_at < $2`,
      [ACTIVE_STATUSES as unknown as string[], olderThan],
    );
    return res.rowCount ?? 0;
  }
}
