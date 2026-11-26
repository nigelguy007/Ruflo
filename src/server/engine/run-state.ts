import type { Id, Run, RunStatus, StepRun } from '../../shared/types.js';
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

/** The store half of ending a run, for use inside the caller's transaction. */
function closeRun(
  ctx: EngineContext,
  runId: Id,
  status: TerminalStatus,
  stopReason: string | null,
): Run {
  ctx.store.runs.skipOpenSteps(runId);
  return ctx.store.runs.update(runId, {
    status,
    stopReason,
    finishedAt: iso(ctx.clock()),
    currentStepId: null,
    parked: false,
  });
}

function announceEnd(ctx: EngineContext, run: Run): void {
  ctx.bus.publish({ type: 'run.updated', run });
  rememberRun(ctx, run);
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
  const run = ctx.store.transaction(() => closeRun(ctx, runId, status, stopReason));
  announceEnd(ctx, run);
  return run;
}

/** The step that caused a failure, so it can be marked failed in the same transaction as its run. */
export interface FailedStep {
  stepId: string;
  summary: string;
}

/**
 * Ends a run as failed and writes the reason on the timeline in plain words.
 * The step that failed (when there is one), the timeline entry and the end of
 * the run are written in ONE transaction: a crash can never leave a failed
 * step inside a run that is still going.
 */
export function failRun(
  ctx: EngineContext,
  runId: Id,
  stopReason: string,
  failedStep?: FailedStep,
): Run {
  const run = ctx.store.transaction(() => {
    if (failedStep !== undefined) {
      ctx.store.runs.updateStep(runId, failedStep.stepId, {
        status: 'failed',
        finishedAt: iso(ctx.clock()),
        summary: failedStep.summary,
      });
    }
    ctx.ledger.append({ runId, actor: SYSTEM_ACTOR, kind: 'error', text: stopReason });
    return closeRun(ctx, runId, 'failed', stopReason);
  });
  announceEnd(ctx, run);
  return run;
}

/**
 * The failed step of a run that has not ended. Steps and runs are ended together,
 * so this is what a crash between the two would have left behind.
 */
export function strandedFailure(run: Run): StepRun | null {
  return isTerminal(run.status) ? null : (run.steps.find((step) => step.status === 'failed') ?? null);
}

/** Why a run with a stranded failure is ended instead of carried on. */
export function strandedStopReason(step: StepRun): string {
  return `Stopped: "${step.title}" had already failed, but the run was still going when Switchyard picked it up again. It ends here instead of carrying on past a failed step.`;
}
