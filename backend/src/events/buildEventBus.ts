/* ==========================================================================
   BuildMind API — events/buildEventBus.ts
   In-process pub/sub for build events, plus the SSE subscriber registry.

   The bus is deliberately keyed by `${buildId}:${runId}`. A subscriber that
   attached to an old run never receives a new run's events, even though the
   build id is the same. That is the mechanism behind "a retried build cannot
   be repainted by an old run's event stream".

   Events are also persisted (build_events) before they are published, so a
   client that reconnects can replay from `?after=<seq>` and miss nothing.
   ========================================================================== */

import type { EventEmitter } from 'node:events';

export interface BuildEventPayload {
  buildId: string;
  runId: string;
  seq: number;
  stage: string | null;
  status: string;
  progress: number;
  activity: string;
  timestamp: string;
}

export type BuildEventListener = (event: BuildEventPayload) => void;

function channel(buildId: string, runId: string): string {
  return `${buildId}:${runId}`;
}

export class BuildEventBus {
  private readonly emitter: EventEmitter;
  private readonly counts = new Map<string, number>();

  constructor(emitter: EventEmitter) {
    this.emitter = emitter;
  }

  publish(event: BuildEventPayload): void {
    this.emitter.emit(channel(event.buildId, event.runId), event);
  }

  /**
   * Subscribe to one run of one build. Returns an unsubscribe function which
   * is idempotent — a double-call (client disconnect racing a timeout) must
   * not corrupt the listener count.
   */
  subscribe(buildId: string, runId: string, listener: BuildEventListener): () => void {
    const key = channel(buildId, runId);
    this.emitter.on(key, listener);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.emitter.off(key, listener);
      const next = (this.counts.get(key) ?? 1) - 1;
      if (next <= 0) this.counts.delete(key);
      else this.counts.set(key, next);
    };
  }

  /** Exposed for the listener-leak test: no subscriber should leak. */
  listenerCount(buildId: string, runId: string): number {
    return this.counts.get(channel(buildId, runId)) ?? 0;
  }

  totalListeners(): number {
    let total = 0;
    for (const n of this.counts.values()) total += n;
    return total;
  }
}
