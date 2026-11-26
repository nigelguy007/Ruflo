import type { Id, Playbook, Run, Step } from '../../../shared/types.js';
import { budgetRanOutDuring, remainingMs } from '../budget.js';
import type { EngineContext } from '../context.js';
import { BudgetExhaustedError, StepTimeoutError } from '../errors.js';
import { clipTail } from '../text.js';
import { iso } from '../time.js';

/** Used when a step does not set `timeoutSeconds`. */
export const DEFAULT_TIMEOUT_SECONDS = 600;
const SECOND_MS = 1_000;

/** One step about to be executed, with the run as it was when the runner picked it. */
export interface StepFrame<S extends Step = Step> {
  run: Run;
  playbook: Playbook;
  step: S;
}

/** `next`: go on to the following step. `halt`: the run is parked at a gate, has ended, or was cancelled. */
export type StepOutcome = 'next' | 'halt';

/** What is left of the run's minutes when a step starts, and what to say if they run out under it. */
export interface StepBudget {
  remainingMs: number;
  reason: string;
}

export interface StartedStep {
  run: Run;
  attempt: number;
  /** Fires when the run is cancelled or the step runs out of time. */
  abort: AbortController;
  /** Lets `withDeadline` stop the step when the run's minutes run out, not only when the step's own timeout does. */
  budget: StepBudget;
}

/** Marks the step and its run as running and registers the abort handle that `cancel` uses. */
export function beginStep(ctx: EngineContext, frame: StepFrame): StartedStep {
  const { run: before, step } = frame;
  const now = iso(ctx.clock());
  const attempt = (before.steps.find((s) => s.stepId === step.id)?.attempt ?? 0) + 1;
  const run = ctx.store.transaction(() => {
    ctx.store.runs.updateStep(before.id, step.id, {
      status: 'running',
      attempt,
      startedAt: now,
      finishedAt: null,
    });
    return ctx.store.runs.update(before.id, {
      status: 'running',
      startedAt: before.startedAt ?? now,
      currentStepId: step.id,
      parked: false,
      ...(step.kind === 'agent' ? { addAgentStepsStarted: 1 } : {}),
    });
  });
  ctx.bus.publish({ type: 'run.updated', run });
  const abort = new AbortController();
  ctx.inflight.set(run.id, abort);
  return { run, attempt, abort, budget: budgetFor(ctx, frame, run) };
}

function budgetFor(ctx: EngineContext, frame: StepFrame, run: Run): StepBudget {
  const { budget } = frame.playbook;
  const meta = ctx.store.runs.meta(run.id);
  return {
    // Without bookkeeping there is nothing to measure against; the step's own timeout still applies.
    remainingMs: meta === null ? Number.POSITIVE_INFINITY : remainingMs(budget, run, meta, ctx.clock()),
    reason: budgetRanOutDuring(budget, frame.step),
  };
}

/** Removes the abort handle, unless a newer step of the same run has already replaced it. */
export function releaseStep(ctx: EngineContext, runId: Id, abort: AbortController): void {
  if (ctx.inflight.get(runId) === abort) ctx.inflight.delete(runId);
}

/**
 * After every wait the world may have moved on: the run can have been
 * cancelled, or the server can be shutting down, while the step was in flight.
 * A step must not write its result unless it is still the step the run is
 * executing.
 */
export function stillCurrent(ctx: EngineContext, runId: Id, stepId: string): boolean {
  if (ctx.lifecycle.stopping) return false;
  const run = ctx.store.runs.get(runId);
  if (!run || run.status !== 'running' || run.currentStepId !== stepId) return false;
  return run.steps.some((step) => step.stepId === stepId && step.status === 'running');
}

/** In simulate mode, a short pause before each step so a person can watch the run unfold. */
export async function pace(ctx: EngineContext, abort: AbortController): Promise<void> {
  if (ctx.config.mode !== 'simulate' || ctx.config.stepDelayMs <= 0) return;
  await ctx.sleep(ctx.config.stepDelayMs, abort.signal);
}

/**
 * Runs `work` until it settles, the step times out, the run's minutes run out
 * (when `budget` is given) or `abort` fires, whichever comes first. The race
 * means work that ignores the abort signal still cannot hold the run hostage.
 * When the run's minutes are what ends the step, it fails with the budget
 * message instead of a generic timeout.
 */
export async function withDeadline<T>(
  ctx: EngineContext,
  abort: AbortController,
  seconds: number,
  work: () => Promise<T>,
  budget?: StepBudget,
): Promise<T> {
  const timer = new AbortController();
  const budgetFirst = budget !== undefined && budget.remainingMs < seconds * SECOND_MS;
  const limitMs = budgetFirst ? budget.remainingMs : seconds * SECOND_MS;
  void ctx.sleep(limitMs, timer.signal).then(() => {
    if (timer.signal.aborted) return;
    abort.abort(budgetFirst ? new BudgetExhaustedError(budget.reason) : new StepTimeoutError(seconds));
  });
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(abort.signal.reason);
    if (abort.signal.aborted) fail();
    else abort.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), aborted]);
  } finally {
    timer.abort();
  }
}

/** The end of `text`, at most `maxLength` characters, with a "…" in front when the start was cut off. */
export function tail(text: string, maxLength: number): string {
  return clipTail(text, maxLength);
}
