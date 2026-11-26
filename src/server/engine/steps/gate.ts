import type { Decision, GateStep } from '../../../shared/types.js';
import { SYSTEM_ACTOR } from '../context.js';
import type { EngineContext } from '../context.js';
import { iso } from '../time.js';
import type { StepFrame, StepOutcome } from './shared.js';

/**
 * Opens a decision carrying everything gathered so far and parks the run. The
 * worker slot is released: nothing happens to this run until someone answers.
 */
export function runGateStep(ctx: EngineContext, frame: StepFrame<GateStep>): StepOutcome {
  const { run: before, step } = frame;
  const now = iso(ctx.clock());
  const decision: Decision = {
    id: ctx.newId('dec'),
    runId: before.id,
    runTitle: before.title,
    stepId: step.id,
    question: step.question,
    status: 'open',
    openedAt: now,
    decidedAt: null,
    decidedBy: null,
    note: null,
    evidence: ctx.store.evidence.forRun(before.id),
  };
  // The question, the waiting run and the ledger entry are written together: a crash
  // must never leave a question somebody can answer that the ledger does not record.
  const { run, stored } = ctx.store.transaction(() => {
    const inserted = ctx.store.decisions.insert(decision);
    ctx.store.runs.updateStep(before.id, step.id, { status: 'waiting', startedAt: now, attempt: 1 });
    const waiting = ctx.store.runs.update(before.id, {
      status: 'waiting_gate',
      startedAt: before.startedAt ?? now,
      currentStepId: step.id,
      parked: false,
    });
    ctx.ledger.append({
      runId: waiting.id,
      actor: SYSTEM_ACTOR,
      kind: 'gate_opened',
      text: `Waiting for a decision: ${step.question}`,
      data: { stepId: step.id, decisionId: inserted.id, onReject: step.onReject },
    });
    return { run: waiting, stored: inserted };
  });
  ctx.bus.publish({ type: 'run.updated', run });
  ctx.bus.publish({ type: 'decision.opened', decision: stored });
  return 'halt';
}
