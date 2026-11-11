/* ==========================================================================
   BuildMind API — services/builds/buildOrchestrator.ts
   The real build engine.

   One `run()` call is one build execution. It owns:
     * the state machine transitions, each written with compare-and-set
     * the provider calls for understanding, planning and building
     * the real validation pass, and the fix loop when it fails
     * cancellation checks between every step
     * terminal outcome and workspace cleanup

   Concurrency and race safety:

     * Every write carries `runId`. A transition from a superseded run
       matches zero rows and is discarded (`null` result), so an old run
       cannot advance a newer build.
     * `cancelled` and cancellation-requested are checked before each provider
       call and again before each transition. A cancel that lands mid-call
       results in BUILD_CANCELLED, never in `complete`.
     * The whole run is wrapped in a timeout. A provider that never answers
       cannot leave a build active forever.

   What this engine does NOT do: it does not execute generated Luau, does not
   run Studio, and does not claim runtime Roblox validation. Those are
   reported separately by the Studio bridge, with their own status.
   ========================================================================== */


import { AppError, type ErrorCode } from '../../errors/AppError.js';
import {
  BUILD_TIMEOUT_MS,
  MAX_FIX_ATTEMPTS,
  PROVIDER_TIMEOUT_MS,
} from '../../config/constants.js';
import {
  BuildPlanSchema,
  GameSpecificationSchema,
  GenerationSchema,
  FixPlanSchema,
} from '../../validation/schemas.js';
import {
  STAGE_PROGRESS,
  type BuildStage,
  type BuildStatus,
} from './stateMachine.js';
import { validateAgainstPlan, validateArtifacts, validateManifest } from './artifactService.js';
import { BuildRepository, type Build } from '../../repositories/builds/buildRepository.js';
import { ProjectService } from '../projects/projectService.js';
import { WorkspaceManager } from '../../workspace/workspaceManager.js';
import { BuildEventBus } from '../../events/buildEventBus.js';
import type { ProviderRegistry } from '../../providers/ai/registry.js';
import type { ProviderCredential, GenerateResult } from '../../providers/ai/types.js';
import {
  SYSTEM_BUILDING,
  SYSTEM_FIXING,
  SYSTEM_PLANNING,
  SYSTEM_UNDERSTANDING,
  buildingPrompt,
  fixingPrompt,
  planningPrompt,
  understandingPrompt,
} from '../ai/promptTemplates.js';

export interface BuildJob {
  buildId: string;
  userId: string;
  projectId: string;
  prompt: string;
  provider: string;
  model: string;
  credential: ProviderCredential;
}

/** Evidence retained for a build. Safe to show a user. */
export interface ValidationEvidence {
  artifactCount: number;
  totalBytes: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  fixAttempts: number;
  backendValidation: 'passed' | 'failed' | 'not_run';
  studioValidation: 'not_run' | 'passed' | 'failed';
  runtimeValidation: 'not_run' | 'passed' | 'failed';
}

export class BuildOrchestrator {
  private readonly builds: BuildRepository;
  private readonly projects: ProjectService;
  private readonly workspace: WorkspaceManager;
  private readonly bus: BuildEventBus;
  private readonly providers: ProviderRegistry;
  /** buildId → AbortController, so a cancel can abort an in-flight provider call. */
  private readonly controllers = new Map<string, AbortController>();
  /** buildId → runId currently executing. */
  private readonly activeRuns = new Map<string, string>();

  constructor(deps: {
    builds: BuildRepository;
    projects: ProjectService;
    workspace: WorkspaceManager;
    bus: BuildEventBus;
    providers: ProviderRegistry;
  }) {
    this.builds = deps.builds;
    this.projects = deps.projects;
    this.workspace = deps.workspace;
    this.bus = deps.bus;
    this.providers = deps.providers;
  }

  /** True when this build+run is still the active execution. */
  isCurrent(buildId: string, runId: string): boolean {
    return this.activeRuns.get(buildId) === runId;
  }

  activeRunFor(buildId: string): string | undefined {
    return this.activeRuns.get(buildId);
  }

  /** Abort whatever provider work is running for a build. */
  abort(buildId: string): void {
    const controller = this.controllers.get(buildId);
    if (controller) controller.abort();
  }

  /* ------------------------------------------------------------ helpers -- */

  private async emit(
    job: BuildJob,
    runId: string,
    status: BuildStatus,
    stage: BuildStage | null,
    progress: number,
    activity: string,
  ): Promise<void> {
    const event = await this.builds.appendEvent({
      buildId: job.buildId,
      userId: job.userId,
      runId,
      stage,
      status,
      progress,
      activity,
    });
    if (!event) return;
    this.bus.publish({
      buildId: job.buildId,
      runId,
      seq: event.seq,
      stage: event.stage,
      status: event.status,
      progress: event.progress,
      activity: event.activity,
      timestamp: new Date().toISOString(),
    });
  }

  private async cancelled(buildId: string, runId: string): Promise<boolean> {
    return this.builds.isCancelRequested(buildId, runId);
  }

  /**
   * Advance the state machine. Returns false when the compare-and-set matched
   * nothing, which means someone else moved the build — the caller must stop.
   */
  private async transition(
    job: BuildJob,
    runId: string,
    expected: BuildStatus,
    next: BuildStatus,
    stage: BuildStage | null,
    progress: number,
  ): Promise<boolean> {
    const updated = await this.builds.transition({
      id: job.buildId,
      userId: job.userId,
      runId,
      expected,
      next,
      stage,
      progress,
    });
    return updated !== null;
  }

  private async finish(
    job: BuildJob,
    runId: string,
    status: 'complete' | 'failed' | 'cancelled',
    stage: BuildStage | null,
    progress: number,
    code: ErrorCode | null,
    activity: string,
  ): Promise<void> {
    const current = await this.builds.findById(job.buildId, job.userId);
    if (!current || current.runId !== runId) return; // superseded

    await this.builds.transition({
      id: job.buildId,
      userId: job.userId,
      runId,
      expected: current.status,
      next: status,
      stage,
      progress,
      errorCode: code,
      errorMessageSafe: code ? safeTextFor(code) : null,
    });

    await this.emit(job, runId, status, stage, progress, activity);

    if (status === 'complete') {
      await this.projects.markBuilt(job.userId, job.projectId, new Date());
    } else if (status === 'cancelled') {
      await this.projects.setStatus(job.userId, job.projectId, 'stopped');
    } else {
      await this.projects.setStatus(job.userId, job.projectId, 'error');
    }

    this.activeRuns.delete(job.buildId);
    this.controllers.delete(job.buildId);
  }

  /* ---------------------------------------------------------------- run -- */

  /**
   * Execute a build. Resolves when the build reaches a terminal state; never
   * rejects — the outcome is recorded in the database and the event stream.
   */
  async run(job: BuildJob): Promise<void> {
    // The row's run_id is authoritative: it was assigned when the build was
    // created, and every compare-and-set below matches on it. A retry is a new
    // row, so a retry automatically gets a new run id.
    const existing = await this.builds.findById(job.buildId, job.userId);
    if (!existing) return;
    const runId = existing.runId;

    this.activeRuns.set(job.buildId, runId);

    const controller = new AbortController();
    this.controllers.set(job.buildId, controller);

    // Stamp the run id onto the build row first. From here on, every write
    // from a previous run is dead.
    const claimed = await this.builds.transition({
      id: job.buildId,
      userId: job.userId,
      runId,
      expected: 'queued',
      next: 'preparing',
    });
    if (!claimed) {
      this.activeRuns.delete(job.buildId);
      this.controllers.delete(job.buildId);
      return; // another run got there first
    }

    const timeout = setTimeout(() => {
      controller.abort();
    }, BUILD_TIMEOUT_MS);

    try {
      await this.emit(job, runId, 'preparing', null, 2, 'Preparing the build workspace');
      await this.workspace.ensure(job.userId, job.buildId);

      const outcome = await this.execute(job, runId, controller.signal);
      if (!outcome.finished) await this.finishOutcome(job, runId, outcome);
    } catch (err) {
      await this.handleFailure(job, runId, err);
    } finally {
      clearTimeout(timeout);
      if (this.activeRuns.get(job.buildId) === runId) {
        this.activeRuns.delete(job.buildId);
        this.controllers.delete(job.buildId);
      }
    }
  }

  private async finishOutcome(
    job: BuildJob,
    runId: string,
    outcome: { status: 'complete' | 'failed' | 'cancelled'; code: ErrorCode | null; activity: string },
  ): Promise<void> {
    await this.finish(
      job,
      runId,
      outcome.status,
      outcome.status === 'complete' ? 'complete' : null,
      outcome.status === 'complete' ? 100 : STAGE_PROGRESS.validating,
      outcome.code,
      outcome.activity,
    );
  }

  private async handleFailure(job: BuildJob, runId: string, err: unknown): Promise<void> {
    const code: ErrorCode = err instanceof AppError ? err.code : 'BUILD_FAILED';
    const status = code === 'BUILD_CANCELLED' ? 'cancelled' : 'failed';
    const activity =
      status === 'cancelled' ? 'Build cancelled' : 'The build stopped before validation finished';
    await this.finish(job, runId, status, null, STAGE_PROGRESS.validating, code, activity);
  }

  /** The stage sequence. Returns a terminal outcome or throws. */
  private async execute(
    job: BuildJob,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ finished: boolean; status: 'complete' | 'failed' | 'cancelled'; code: ErrorCode | null; activity: string }> {
    const provider = this.providers.get(job.provider);

    /* ---------------------------------------------------- understanding -- */
    await this.advance(job, runId, 'preparing', 'understanding', 'understanding');
    await this.emit(job, runId, 'understanding', 'understanding', STAGE_PROGRESS.understanding, 'Reading the game idea');

    const specResult = await this.callProvider(provider, job, signal, SYSTEM_UNDERSTANDING, understandingPrompt(job.prompt), 'specification');
    const specification = this.parse(specResult, GameSpecificationSchema, 'specification');
    await this.workspace.writeJson(job.userId, job.buildId, 'specification.json', specification);
    await this.emit(job, runId, 'understanding', 'understanding', STAGE_PROGRESS.understanding, `Specified: ${specification.name}`);

    await this.checkCancel(job, runId);

    /* --------------------------------------------------------- planning -- */
    await this.advance(job, runId, 'understanding', 'planning', 'planning');
    await this.emit(job, runId, 'planning', 'planning', STAGE_PROGRESS.planning, 'Structuring gameplay and systems');

    const planResult = await this.callProvider(
      provider,
      job,
      signal,
      SYSTEM_PLANNING,
      planningPrompt(job.prompt, JSON.stringify(specification)),
      'plan',
    );
    const plan = this.parse(planResult, BuildPlanSchema, 'plan');
    await this.workspace.writeJson(job.userId, job.buildId, 'plan.json', plan);
    await this.emit(job, runId, 'planning', 'planning', STAGE_PROGRESS.planning, `Planned ${plan.steps.length} step(s)`);

    await this.checkCancel(job, runId);

    /* --------------------------------------------------------- building -- */
    await this.advance(job, runId, 'planning', 'building', 'building');
    await this.emit(job, runId, 'building', 'building', STAGE_PROGRESS.building, 'Creating the required game systems');

    const buildResult = await this.callProvider(
      provider,
      job,
      signal,
      SYSTEM_BUILDING,
      buildingPrompt(job.prompt, JSON.stringify(specification), JSON.stringify(plan)),
      'generation',
    );
    const generation = this.parse(buildResult, GenerationSchema, 'generation');

    let validation = validateArtifacts(generation.artifacts);
    let issues = [...validation.issues];
    if (validation.valid) {
      issues = [
        ...validateAgainstPlan(validation.artifacts, plan.files),
        ...validateManifest(validation.artifacts),
      ];
    }

    await this.emit(job, runId, 'building',
      'building',
      STAGE_PROGRESS.building,
      `Produced ${generation.artifacts.length} artifact(s)`,
    );

    /* ------------------------------------------ testing / fixing / retest -- */
    let fixAttempts = 0;

    // Testing always runs, even when the first generation looks clean: the
    // stage is a real pass over the artifacts, not a branch that only exists
    // when something is wrong.
    await this.advanceTo(job, runId, 'testing');
    await this.emit(
      job,
      runId,
      'testing',
      'testing',
      STAGE_PROGRESS.testing,
      issues.length === 0 ? 'All checks passed' : `Found ${issues.length} issue(s)`,
    );

    while (issues.length > 0) {
      await this.checkCancel(job, runId);

      if (fixAttempts >= MAX_FIX_ATTEMPTS) {
        await this.workspace.writeJson(job.userId, job.buildId, 'result.json', {
          status: 'failed',
          reason: 'fix-limit-reached',
          issues,
          fixAttempts,
        });
        await this.finish(job, runId, 'failed', null, STAGE_PROGRESS.fixing, 'BUILD_FAILED', 'Fix attempts exhausted');
        return { finished: true, status: 'failed', code: 'BUILD_FAILED', activity: 'Fix attempts exhausted' };
      }

      fixAttempts += 1;
      await this.advanceTo(job, runId, 'fixing');
      await this.emit(job, runId, 'fixing', 'fixing', STAGE_PROGRESS.fixing, `Repairing (attempt ${fixAttempts})`);

      const fixResult = await this.callProvider(
        provider,
        job,
        signal,
        SYSTEM_FIXING,
        fixingPrompt(issues, JSON.stringify(validation.artifacts.map(({ path, content }) => ({ path, content })))),
        'fix',
      );
      const fix = this.parse(fixResult, FixPlanSchema, 'fix');

      validation = validateArtifacts(fix.artifacts);
      issues = [...validation.issues];
      if (validation.valid) {
        issues = [
          ...validateAgainstPlan(validation.artifacts, plan.files),
          ...validateManifest(validation.artifacts),
        ];
      }
      await this.emit(job, runId, 'fixing', 'fixing', STAGE_PROGRESS.fixing, `Applied: ${fix.diagnosis.slice(0, 80)}`);

      // Always re-test after a repair: `fixing` may only go back to
      // `testing`, never straight to `validating`. This is what makes "we
      // fixed it" and "it now passes" two separate, evidenced steps.
      await this.advanceTo(job, runId, 'testing');
      await this.emit(
        job,
        runId,
        'testing',
        'testing',
        STAGE_PROGRESS.testing,
        issues.length === 0 ? 'All checks passed' : `Found ${issues.length} issue(s)`,
      );
    }

    /* ------------------------------------------------------- validating -- */
    await this.checkCancel(job, runId);
    await this.advanceTo(job, runId, 'validating');
    await this.emit(job, runId, 'validating', 'validating', STAGE_PROGRESS.validating, 'Checking the generated result');

    // Persist only after validation passes: a failed build writes no artifacts.
    await this.workspace.writeArtifacts(job.userId, job.buildId, validation.artifacts);

    const totalBytes = validation.artifacts.reduce((sum, a) => sum + a.bytes, 0);
    const evidence: ValidationEvidence = {
      artifactCount: validation.artifacts.length,
      totalBytes,
      checks: [
        { name: 'path-safety', passed: true },
        { name: 'size-limits', passed: true },
        { name: 'type-allowlist', passed: true },
        { name: 'no-duplicate-paths', passed: true },
        { name: 'manifest-valid', passed: true },
        { name: 'planned-files-present', passed: true },
        { name: 'script-present', passed: true },
      ],
      fixAttempts,
      backendValidation: 'passed',
      // Set by the Studio bridge when a plugin actually reports back. Absent
      // means Studio never ran — which is stated, not implied.
      studioValidation: 'not_run',
      runtimeValidation: 'not_run',
    };

    await this.workspace.writeJson(job.userId, job.buildId, 'validation/evidence.json', evidence);
    await this.workspace.writeJson(job.userId, job.buildId, 'result.json', {
      status: 'complete',
      evidence,
    });

    await this.finish(job, runId, 'complete', 'complete', 100, null, 'Build complete');
    return { finished: true, status: 'complete', code: null, activity: 'Build complete' };
  }

  /* ------------------------------------------------------------ support -- */

  private async advance(
    job: BuildJob,
    runId: string,
    expected: BuildStatus,
    next: BuildStatus,
    stage: BuildStage,
  ): Promise<void> {
    const ok = await this.transition(job, runId, expected, next, stage, STAGE_PROGRESS[stage]);
    if (!ok) throw new AppError('BUILD_CONFLICT', { cause: `transition ${expected}->${next} lost the race` });
  }

  /** testing/fixing may be entered from either building or the other. */
  private async advanceTo(job: BuildJob, runId: string, target: 'testing' | 'fixing' | 'validating'): Promise<void> {
    const current = await this.builds.findById(job.buildId, job.userId);
    if (!current || current.runId !== runId) throw new AppError('BUILD_CONFLICT');

    if (current.status === target) return;
    if (current.status === 'cancelled') throw new AppError('BUILD_CANCELLED');

    const ok = await this.transition(job, runId, current.status, target, target, STAGE_PROGRESS[target]);
    if (!ok) {
      // Someone else moved it (a cancel, most likely).
      const after = await this.builds.findById(job.buildId, job.userId);
      throw new AppError(after?.status === 'cancelled' ? 'BUILD_CANCELLED' : 'BUILD_CONFLICT');
    }
    await this.emit(job, runId, target, target, STAGE_PROGRESS[target], `${target}`);
  }

  private async checkCancel(job: BuildJob, runId: string): Promise<void> {
    if (await this.cancelled(job.buildId, runId)) {
      throw new AppError('BUILD_CANCELLED');
    }
    if (!this.isCurrent(job.buildId, runId)) {
      throw new AppError('BUILD_CONFLICT');
    }
  }

  private async callProvider(
    provider: ReturnType<ProviderRegistry['get']>,
    job: BuildJob,
    signal: AbortSignal,
    system: string,
    user: string,
    _label: string,
  ): Promise<GenerateResult> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
    try {
      return await provider.generate(job.credential, {
        model: job.model,
        system,
        user,
        json: true,
        signal: combined,
      });
    } catch (err) {
      if (signal.aborted) throw new AppError('BUILD_CANCELLED', { cause: err });
      throw err;
    }
  }

  /** Parse and schema-validate a model response. Malformed output fails safely. */
  private parse<T>(result: GenerateResult, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } } }, label: string): T {
    if (result.truncated) {
      throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: `${label} response was truncated` });
    }

    let json: unknown;
    try {
      json = JSON.parse(stripFences(result.text));
    } catch {
      throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: `${label} was not JSON` });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success || parsed.data === undefined) {
      const first = parsed.error?.issues[0];
      const where = first?.path.join('.') ?? 'root';
      throw new AppError('PROVIDER_INVALID_OUTPUT', { cause: `${label} failed schema at ${where}: ${first?.message ?? 'invalid'}` });
    }
    return parsed.data;
  }
}

/** Strip a markdown code fence if a model added one despite instructions. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(trimmed);
  return fence && fence[1] ? fence[1].trim() : trimmed;
}

function safeTextFor(code: ErrorCode): string {
  const map: Partial<Record<ErrorCode, string>> = {
    BUILD_FAILED: 'The build did not complete.',
    BUILD_CANCELLED: 'The build was cancelled.',
    BUILD_TIMEOUT: 'The build ran out of time.',
    BUILD_CONFLICT: 'This build has already changed state.',
    PROVIDER_INVALID_OUTPUT: 'The AI provider returned something unusable.',
    PROVIDER_TIMEOUT: 'The AI provider took too long to respond.',
    PROVIDER_AUTH_FAILED: 'The AI provider rejected those credentials.',
    PROVIDER_UNAVAILABLE: 'The AI provider is not reachable right now.',
    PROVIDER_RATE_LIMITED: 'The AI provider is rate limiting this account.',
  };
  return map[code] ?? 'The build did not complete.';
}

export type { Build };
