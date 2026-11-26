import type { Id, Run } from '../../shared/types.js';
import { errorMessage } from '../logger.js';
import { budgetBreach } from './budget.js';
import type { EngineContext } from './context.js';
import { endRun, failRun, saveRun, strandedFailure, strandedStopReason, systemNote } from './run-state.js';
import { runAgentStep } from './steps/agent.js';
import { runCommandStep } from './steps/command.js';
import { runGateStep } from './steps/gate.js';
import type { StepFrame, StepOutcome } from './steps/shared.js';

const PAUSED_NOTE =
  'Paused: Switchyard is globally paused, so no new step will start. This run continues when the pause is lifted.';
const INTERNAL_STOP_REASON =
  'Stopped: Switchyard hit an internal error while advancing this run. The details are in the server log.';

/** Holds a run back under the global pause. The note is written once, not on every check. */
function park(ctx: EngineContext, run: Run): void {
  if (ctx.store.runs.meta(run.id)?.parked) return;
  saveRun(ctx, run.id, { parked: true, status: 'queued' });
  systemNote(ctx, run.id, PAUSED_NOTE);
}

/**
 * Decides what the run does next. Returns the step to execute, or null when
 * there is nothing to do right now: the run is paused, waiting, or has ended.
 */
function nextFrame(ctx: EngineContext, runId: Id): StepFrame | null {
  const run = ctx.store.runs.get(runId);
  if (!run || (run.status !== 'queued' && run.status !== 'running')) return null;
  const stranded = strandedFailure(run);
  if (stranded !== null) {
    failRun(ctx, runId, strandedStopReason(stranded));
    return null;
  }
  if (ctx.store.settings.paused()) {
    park(ctx, run);
    return null;
  }
  const index = run.steps.findIndex((step) => step.status === 'pending');
  if (index === -1) {
    endRun(ctx, runId, 'succeeded', null);
    return null;
  }
  const playbook = ctx.store.runs.playbook(runId);
  const meta = ctx.store.runs.meta(runId);
  const step = playbook?.steps[index];
  if (!playbook || !meta || !step) {
    failRun(ctx, runId, 'Stopped: the playbook stored with this run can no longer be read.');
    return null;
  }
  const breach = budgetBreach(playbook.budget, run, meta, step, ctx.clock());
  if (breach !== null) {
    failRun(ctx, runId, breach);
    return null;
  }
  return { run, playbook, step };
}

function executeStep(ctx: EngineContext, frame: StepFrame): Promise<StepOutcome> | StepOutcome {
  const { step } = frame;
  switch (step.kind) {
    case 'agent':
      return runAgentStep(ctx, { ...frame, step });
    case 'command':
      return runCommandStep(ctx, { ...frame, step });
    case 'gate':
      return runGateStep(ctx, { ...frame, step });
  }
}

async function advance(ctx: EngineContext, runId: Id): Promise<void> {
  while (!ctx.lifecycle.stopping) {
    const frame = nextFrame(ctx, runId);
    if (frame === null) return;
    const outcome = await executeStep(ctx, frame);
    if (outcome === 'halt') return;
  }
}

/**
 * The work function for the queue: advances one run step by step until it
 * ends, parks at a gate or is held by the pause. An unexpected error fails
 * the run rather than leaving it stuck in `running` forever.
 */
export function createRunner(ctx: EngineContext): (runId: Id) => Promise<void> {
  return async (runId) => {
    try {
      await advance(ctx, runId);
    } catch (error) {
      ctx.log.error('run failed unexpectedly', { runId, error: errorMessage(error) });
      ctx.inflight.delete(runId);
      try {
        failRun(ctx, runId, INTERNAL_STOP_REASON);
      } catch (inner) {
        ctx.log.error('could not record run failure', { runId, error: errorMessage(inner) });
      }
    }
  };
}
