/* ==========================================================================
   BuildMind API — services/builds/stateMachine.ts
   The build lifecycle, defined once and enforced everywhere.

   The transition table is the single authority: the orchestrator, the cancel
   endpoint and the retry endpoint all consult it. A transition not listed
   here is rejected, which is what makes "a cancelled build can never later
   become complete" a property of the code rather than a hope.

   Two invariants worth stating explicitly:

     * Terminal states (complete, failed, cancelled) have no outgoing edges.
     * Only `queued`, `preparing` and the six working stages can be cancelled;
       attempts to cancel a terminal build are rejected as a conflict.
   ========================================================================== */

export const BUILD_STATUSES = [
  'queued',
  'preparing',
  'understanding',
  'planning',
  'building',
  'testing',
  'fixing',
  'validating',
  'complete',
  'failed',
  'cancelled',
] as const;

export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** The seven product stages, in order. */
export const BUILD_STAGES = [
  'understanding',
  'planning',
  'building',
  'testing',
  'fixing',
  'validating',
  'complete',
] as const;

export type BuildStage = (typeof BUILD_STAGES)[number];

export const TERMINAL_STATUSES: readonly BuildStatus[] = ['complete', 'failed', 'cancelled'];

/** Statuses in which a build holds a worker and a provider connection. */
export const ACTIVE_STATUSES: readonly BuildStatus[] = BUILD_STATUSES.filter(
  (s) => !TERMINAL_STATUSES.includes(s),
);

const TRANSITIONS: Record<BuildStatus, readonly BuildStatus[]> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['understanding', 'cancelled', 'failed'],
  understanding: ['planning', 'fixing', 'cancelled', 'failed'],
  planning: ['building', 'cancelled', 'failed'],
  building: ['testing', 'cancelled', 'failed'],
  // Cancellation must be reachable from every active stage, otherwise a build
  // stopped during testing or validating would have no legal terminal state.
  testing: ['validating', 'fixing', 'cancelled', 'failed'],
  // The fix loop: fixing always returns to testing, never straight to complete.
  fixing: ['testing', 'cancelled', 'failed'],
  validating: ['complete', 'failed', 'fixing', 'cancelled'],
  complete: [],
  failed: [],
  cancelled: [],
};

export function isBuildStatus(value: string): value is BuildStatus {
  return (BUILD_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: BuildStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: BuildStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: BuildStatus,
    public readonly to: BuildStatus,
  ) {
    super(`Invalid build transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidTransitionError when the edge does not exist. */
export function assertTransition(from: BuildStatus, to: BuildStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Progress target per stage, mirroring the frontend timeline. */
export const STAGE_PROGRESS: Record<BuildStage, number> = {
  understanding: 12,
  planning: 28,
  building: 58,
  testing: 74,
  fixing: 84,
  validating: 94,
  complete: 100,
};

/** User-facing stage labels, matching the existing frontend vocabulary. */
export const STAGE_LABEL: Record<BuildStage, string> = {
  understanding: 'Understanding',
  planning: 'Planning',
  building: 'Building',
  testing: 'Testing',
  fixing: 'Fixing',
  validating: 'Validating',
  complete: 'Complete',
};
