import type { Budget, Run, Step } from '../../shared/types.js';
import type { RunMeta } from '../db/index.js';
import { MINUTE_MS } from './time.js';

/**
 * How long the run has been going, not counting time spent waiting at a gate.
 * A run that has not started a step yet has used nothing.
 */
export function activeMs(run: Run, meta: RunMeta, now: Date): number {
  if (run.startedAt === null) return 0;
  return Math.max(0, now.getTime() - Date.parse(run.startedAt) - meta.gateWaitMs);
}

/** How long the run may keep working before its minutes are used up. Zero once they are. */
export function remainingMs(budget: Budget, run: Run, meta: RunMeta, now: Date): number {
  return Math.max(0, budget.maxMinutes * MINUTE_MS - activeMs(run, meta, now));
}

/** The stop reason when the minutes run out while `step` is still working. */
export function budgetRanOutDuring(budget: Budget, step: Step): string {
  const minutes = `${budget.maxMinutes} ${budget.maxMinutes === 1 ? 'minute' : 'minutes'}`;
  return `Stopped during "${step.title}": this run used up the ${minutes} its playbook allows while the step was still working. Time spent waiting for a decision is not counted.`;
}

/**
 * Checked before every step. Returns the reason the run must stop, in plain
 * words, or null when `next` may start. The counts are checked ahead of time:
 * a step that would take the run over a limit never starts.
 */
export function budgetBreach(
  budget: Budget,
  run: Run,
  meta: RunMeta,
  next: Step,
  now: Date,
): string | null {
  const before = `Stopped before "${next.title}"`;
  const minutes = Math.floor(activeMs(run, meta, now) / MINUTE_MS);
  if (minutes >= budget.maxMinutes) {
    return `${before}: this run has been working for ${minutes} minutes and its playbook allows ${budget.maxMinutes}. Time spent waiting for a decision is not counted.`;
  }
  if (next.kind !== 'agent') return null;
  if (meta.agentStepsStarted >= budget.maxAgentSteps) {
    return `${before}: the playbook allows ${budget.maxAgentSteps} agent steps and this run has already started ${meta.agentStepsStarted}.`;
  }
  if (next.handoffTo !== undefined && meta.handoffs >= budget.maxHandoffs) {
    return `${before}: the playbook allows ${budget.maxHandoffs} handoffs between operators and this run has already made ${meta.handoffs}.`;
  }
  return null;
}
