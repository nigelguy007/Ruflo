import type { OperatorConfig } from '../../shared/schemas.js';
import type { Digest, Operator, Overview, Run, StepRun } from '../../shared/types.js';
import { ACTIVE_STATUSES } from '../db/index.js';
import { SYSTEM_ACTOR } from './context.js';
import type { EngineContext } from './context.js';
import { iso } from './time.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_RUNS = 1_000;

type Activity = Pick<Operator, 'status' | 'currentRunId' | 'currentActivity'>;

const IDLE: Activity = { status: 'idle', currentRunId: null, currentActivity: null };
const PAUSED: Activity = { status: 'paused', currentRunId: null, currentActivity: null };

function runningStepOf(run: Run, operatorId: string): StepRun | null {
  if (run.status !== 'running') return null;
  return (
    run.steps.find((s) => s.kind === 'agent' && s.operator === operatorId && s.status === 'running') ??
    null
  );
}

/** The gate a run is parked at, when the last agent step finished before it belongs to this operator. */
function gateWaitingOn(run: Run, operatorId: string): StepRun | null {
  if (run.status !== 'waiting_gate') return null;
  const gateIndex = run.steps.findIndex((s) => s.kind === 'gate' && s.status === 'waiting');
  if (gateIndex === -1) return null;
  const lastAgent = run.steps
    .slice(0, gateIndex)
    .findLast((s) => s.kind === 'agent' && s.status === 'succeeded');
  return lastAgent?.operator === operatorId ? (run.steps[gateIndex] ?? null) : null;
}

/**
 * Status is derived, never stored: `working` with a running step, `waiting`
 * when its work sits in front of an open gate, `paused` under the global
 * pause, otherwise `idle`.
 */
function activityOf(operator: OperatorConfig, activeRuns: readonly Run[], paused: boolean): Activity {
  for (const run of activeRuns) {
    const step = runningStepOf(run, operator.id);
    if (step) return { status: 'working', currentRunId: run.id, currentActivity: step.title };
  }
  for (const run of activeRuns) {
    const gate = gateWaitingOn(run, operator.id);
    if (gate) {
      return {
        status: 'waiting',
        currentRunId: run.id,
        currentActivity: `Waiting for a decision: ${gate.title}`,
      };
    }
  }
  return paused ? PAUSED : IDLE;
}

export function listOperators(ctx: EngineContext): Operator[] {
  const activeRuns = ctx.store.runs.list({
    statuses: ['running', 'waiting_gate'],
    limit: MAX_ACTIVE_RUNS,
  });
  const paused = ctx.store.settings.paused();
  return ctx.catalog.operators.map((operator) => ({
    ...operator,
    ...activityOf(operator, activeRuns, paused),
  }));
}

/** What happened in the last 24 hours. */
export function buildDigest(ctx: EngineContext): Digest {
  const since = iso(new Date(ctx.clock().getTime() - DAY_MS));
  const counts = ctx.store.runs.digestCounts(since);
  return {
    since,
    handledWithoutYou: counts.handledWithoutYou,
    decisionsMade: ctx.store.decisions.countDecidedSince(since, SYSTEM_ACTOR),
    succeeded: counts.succeeded,
    failed: counts.failed,
    rejected: counts.rejected,
    cancelled: counts.cancelled,
  };
}

export function buildOverview(ctx: EngineContext): Overview {
  return {
    operators: listOperators(ctx),
    openDecisions: ctx.store.decisions.count('open'),
    activeRuns: ctx.store.runs.count(ACTIVE_STATUSES),
    failedRuns: ctx.store.runs.count(['failed']),
    lastSignalAt: ctx.store.signals.lastReceivedAt(),
    digest: buildDigest(ctx),
  };
}
