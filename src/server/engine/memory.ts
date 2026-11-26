import type { Id, Run, Signal } from '../../shared/types.js';
import { errorMessage } from '../logger.js';
import type { MemoryHit } from '../ports.js';
import type { EngineContext } from './context.js';

const RECALL_LIMIT = 3;
const MAX_MEMORY_LENGTH = 1_500;

/** What an operator remembers that looks relevant. Memory is a nicety: a failure is logged and ignored. */
export async function recallFor(
  ctx: EngineContext,
  operatorId: Id,
  signal: Signal,
): Promise<MemoryHit[]> {
  try {
    return await ctx.coordination.recall(operatorId, signal.title, RECALL_LIMIT);
  } catch (error) {
    ctx.log.warn('recall failed', { operatorId, error: errorMessage(error) });
    return [];
  }
}

function participants(run: Run): Id[] {
  const ids = run.steps.flatMap((step) =>
    step.kind === 'agent' && step.operator !== null && step.attempt > 0 ? [step.operator] : [],
  );
  return [...new Set(ids)];
}

function memoryText(run: Run, operatorId: Id): string {
  const own = run.steps
    .filter((step) => step.operator === operatorId && step.summary !== null)
    .map((step) => `${step.title}: ${step.summary}`);
  const outcome = run.stopReason ? `${run.status} (${run.stopReason})` : run.status;
  const text = [`${run.playbookName} for "${run.title}" ended ${outcome}.`, ...own].join(' ');
  return text.slice(0, MAX_MEMORY_LENGTH);
}

/** After a run ends, lets every operator that took part remember the outcome. Never throws. */
export function rememberRun(ctx: EngineContext, run: Run): void {
  const signal = ctx.store.signals.get(run.signalId);
  const tags = [run.playbookId, run.status, ...(signal ? [signal.source, signal.kind] : [])];
  for (const operatorId of participants(run)) {
    const task = Promise.resolve()
      .then(() => ctx.coordination.remember(operatorId, `run:${run.id}`, memoryText(run, operatorId), tags))
      .catch((error: unknown) => {
        ctx.log.warn('remember failed', { operatorId, runId: run.id, error: errorMessage(error) });
      });
    ctx.background(task);
  }
}
