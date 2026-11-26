import type { Run } from '../../shared/types.js';
import type { EngineContext } from './context.js';
import { failRun, saveRun, strandedFailure, strandedStopReason, systemNote } from './run-state.js';

const MAX_RECOVERED = 10_000;

function recoveryNote(run: Run): string {
  const interrupted = run.steps.find((step) => step.status === 'running');
  if (interrupted) {
    return `Switchyard restarted while "${interrupted.title}" was in progress. The step starts again from the beginning.`;
  }
  return 'Switchyard restarted. This run is back in the queue and carries on from where it stopped.';
}

/** Agent steps that were mid-flight: each was counted as started, and will be counted again when it re-runs. */
function interruptedAgentSteps(run: Run): number {
  return run.steps.filter((step) => step.kind === 'agent' && step.status === 'running').length;
}

/**
 * Called once at boot. A run left `queued` or `running` was cut off by a
 * restart: its in-flight step goes back to `pending` and the run is queued
 * again. An agent step that goes back is not charged to the agent-step
 * allowance a second time. A run that already has a failed step was cut off
 * between the step and the run failing: it is ended instead of carried on.
 * Runs waiting at a gate are untouched; they are waiting for a person, not for
 * the process. Returns how many runs were queued again.
 */
export function recover(ctx: EngineContext): number {
  const interrupted = ctx.store.runs
    .list({ statuses: ['queued', 'running'], limit: MAX_RECOVERED })
    .reverse();
  let queued = 0;
  for (const run of interrupted) {
    const stranded = strandedFailure(run);
    if (stranded !== null) {
      failRun(ctx, run.id, strandedStopReason(stranded));
      continue;
    }
    const note = recoveryNote(run);
    const refund = interruptedAgentSteps(run);
    ctx.store.transaction(() => {
      ctx.store.runs.resetRunningSteps(run.id);
      saveRun(ctx, run.id, { status: 'queued', ...(refund > 0 ? { addAgentStepsStarted: -refund } : {}) });
      systemNote(ctx, run.id, note);
    });
    ctx.enqueue(run.id);
    queued += 1;
  }
  if (interrupted.length > 0) {
    ctx.log.info('recovered interrupted runs', { count: queued, ended: interrupted.length - queued });
  }
  return queued;
}
