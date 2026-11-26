import type { Run } from '../../shared/types.js';
import type { EngineContext } from './context.js';
import { saveRun, systemNote } from './run-state.js';

const MAX_RECOVERED = 10_000;

function recoveryNote(run: Run): string {
  const interrupted = run.steps.find((step) => step.status === 'running');
  if (interrupted) {
    return `Switchyard restarted while "${interrupted.title}" was in progress. The step starts again from the beginning.`;
  }
  return 'Switchyard restarted. This run is back in the queue and carries on from where it stopped.';
}

/**
 * Called once at boot. A run left `queued` or `running` was cut off by a
 * restart: its in-flight step goes back to `pending` and the run is queued
 * again. Runs waiting at a gate are untouched; they are waiting for a person,
 * not for the process.
 */
export function recover(ctx: EngineContext): number {
  const interrupted = ctx.store.runs
    .list({ statuses: ['queued', 'running'], limit: MAX_RECOVERED })
    .reverse();
  for (const run of interrupted) {
    const note = recoveryNote(run);
    ctx.store.transaction(() => {
      ctx.store.runs.resetRunningSteps(run.id);
      saveRun(ctx, run.id, { status: 'queued' });
      systemNote(ctx, run.id, note);
    });
    ctx.enqueue(run.id);
  }
  if (interrupted.length > 0) ctx.log.info('recovered interrupted runs', { count: interrupted.length });
  return interrupted.length;
}
