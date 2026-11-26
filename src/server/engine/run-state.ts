import type { Id, Run, RunStatus } from '../../shared/types.js';
import type { RunPatch, StepPatch } from '../db/index.js';
import { SYSTEM_ACTOR } from './context.js';
import type { EngineContext } from './context.js';
import { rememberRun } from './memory.js';
import { iso } from './time.js';

export type TerminalStatus = Extract<RunStatus, 'succeeded' | 'failed' | 'rejected' | 'cancelled'>;

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'rejected', 'cancelled'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Applies a change to a run and tells subscribers about the result. */
export function saveRun(ctx: EngineContext, runId: Id, patch: RunPatch): Run {
  const run = ctx.store.runs.update(runId, patch);
  ctx.bus.publish({ type: 'run.updated', run });
  return run;
}

export function saveStep(ctx: EngineContext, runId: Id, stepId: string, patch: StepPatch): Run {
  const run = ctx.store.runs.updateStep(runId, stepId, patch);
  ctx.bus.publish({ type: 'run.updated', run });
  return run;
}

export function systemNote(ctx: EngineContext, runId: Id, text: string): void {
  ctx.ledger.append({ runId, actor: SYSTEM_ACTOR, kind: 'system', text });
}

/**
 * Ends a run. Steps that never finished become `skipped`, nothing is current
 * any more, and each operator that took part gets to remember how it went.
 */
export function endRun(
  ctx: EngineContext,
  runId: Id,
  status: TerminalStatus,
  stopReason: string | null,
): Run {
  const run = ctx.store.transaction(() => {
    ctx.store.runs.skipOpenSteps(runId);
    return ctx.store.runs.update(runId, {
      status,
      stopReason,
      finishedAt: iso(ctx.clock()),
      currentStepId: null,
      parked: false,
    });
  });
  ctx.bus.publish({ type: 'run.updated', run });
  rememberRun(ctx, run);
  return run;
}

/** Ends a run as failed and writes the reason on the timeline in plain words. */
export function failRun(ctx: EngineContext, runId: Id, stopReason: string): Run {
  ctx.ledger.append({ runId, actor: SYSTEM_ACTOR, kind: 'error', text: stopReason });
  return endRun(ctx, runId, 'failed', stopReason);
}
