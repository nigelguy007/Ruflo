import type { Decision, GateStep, Id, Run, Verdict } from '../../shared/types.js';
import { HUMAN_ACTOR, SYSTEM_ACTOR } from './context.js';
import type { EngineContext } from './context.js';
import { EngineError, RunCancelledError } from './errors.js';
import { endRun, isTerminal, saveRun, systemNote } from './run-state.js';
import { iso } from './time.js';

const CANCEL_REASON = 'Cancelled by a person.';
const CANCEL_DECISION_NOTE = 'Closed without an answer because the run was cancelled.';

function gateOf(ctx: EngineContext, decision: Decision): GateStep | null {
  const step = ctx.store.runs.playbook(decision.runId)?.steps.find((s) => s.id === decision.stepId);
  return step?.kind === 'gate' ? step : null;
}

function withNote(text: string, note: string | null): string {
  return note === null ? `${text}.` : `${text}: ${note}`;
}

/** Applies an answer to the run that was waiting for it. */
function applyVerdict(ctx: EngineContext, decision: Decision, gate: GateStep, by: string): void {
  const approved = decision.status === 'approved';
  const finishedAt = decision.decidedAt;
  const waitedMs = Date.parse(decision.decidedAt ?? decision.openedAt) - Date.parse(decision.openedAt);
  ctx.ledger.append({
    runId: decision.runId,
    actor: HUMAN_ACTOR,
    kind: 'gate_resolved',
    text: withNote(`${approved ? 'Approved' : 'Rejected'} by ${by}`, decision.note),
    data: { stepId: gate.id, decisionId: decision.id, verdict: approved ? 'approve' : 'reject', by },
  });
  if (!approved && gate.onReject === 'stop') {
    const summary = withNote(`Rejected by ${by}`, decision.note);
    ctx.store.runs.updateStep(decision.runId, gate.id, { status: 'failed', finishedAt, summary });
    ctx.store.runs.update(decision.runId, { addGateWaitMs: waitedMs });
    endRun(ctx, decision.runId, 'rejected', withNote(`A person answered no to "${gate.question}"`, decision.note));
    return;
  }
  const summary = approved
    ? withNote(`Approved by ${by}`, decision.note)
    : withNote(`Answered no by ${by}; the playbook carries on`, decision.note);
  ctx.store.runs.updateStep(decision.runId, gate.id, { status: 'succeeded', finishedAt, summary });
  saveRun(ctx, decision.runId, { status: 'queued', addGateWaitMs: waitedMs });
  ctx.enqueue(decision.runId);
}

/**
 * Answers an open decision. Approve resumes the run. Reject ends it as
 * `rejected` when the gate says `stop`, and lets it carry on when the gate
 * says `continue`. A decision can be answered exactly once.
 */
export function decide(
  ctx: EngineContext,
  id: Id,
  verdict: Verdict,
  note: string | null | undefined,
  by: string,
): Decision {
  const existing = ctx.store.decisions.get(id);
  if (!existing) throw new EngineError('not_found', `Decision ${id} does not exist.`);
  const decision = ctx.store.transaction(() => {
    const resolved = ctx.store.decisions.resolve(id, {
      status: verdict === 'approve' ? 'approved' : 'rejected',
      decidedAt: iso(ctx.clock()),
      decidedBy: by,
      note: note?.trim() ? note.trim() : null,
    });
    if (!resolved) {
      throw new EngineError('conflict', `This decision has already been answered (${existing.status}).`);
    }
    const gate = gateOf(ctx, resolved);
    const run = ctx.store.runs.get(resolved.runId);
    if (gate && run?.status === 'waiting_gate' && run.currentStepId === gate.id) {
      applyVerdict(ctx, resolved, gate, by);
    }
    return resolved;
  });
  ctx.bus.publish({ type: 'decision.resolved', decision });
  return decision;
}

/** Closes a cancelled run's open decision, so nobody is asked a question that no longer matters. */
function closeOpenDecision(ctx: EngineContext, runId: Id): Decision | null {
  const open = ctx.store.decisions.openForRun(runId);
  if (!open) return null;
  const closed = ctx.store.decisions.resolve(open.id, {
    status: 'rejected',
    decidedAt: iso(ctx.clock()),
    decidedBy: SYSTEM_ACTOR,
    note: CANCEL_DECISION_NOTE,
  });
  if (closed) {
    ctx.ledger.append({
      runId,
      actor: SYSTEM_ACTOR,
      kind: 'gate_resolved',
      text: CANCEL_DECISION_NOTE,
      data: { stepId: closed.stepId, decisionId: closed.id, verdict: 'reject', by: SYSTEM_ACTOR },
    });
  }
  return closed;
}

/**
 * Cancels a run that has not ended yet. The store is updated first and the
 * in-flight step aborted second, so whatever that step returns is discarded.
 */
export function cancel(ctx: EngineContext, runId: Id): Run {
  const existing = ctx.store.runs.get(runId);
  if (!existing) throw new EngineError('not_found', `Run ${runId} does not exist.`);
  if (isTerminal(existing.status)) {
    throw new EngineError('conflict', `This run has already ended (${existing.status}).`);
  }
  const { run, closed } = ctx.store.transaction(() => {
    systemNote(ctx, runId, 'Run cancelled.');
    const closedDecision = closeOpenDecision(ctx, runId);
    return { run: endRun(ctx, runId, 'cancelled', CANCEL_REASON), closed: closedDecision };
  });
  if (closed) ctx.bus.publish({ type: 'decision.resolved', decision: closed });
  ctx.inflight.get(runId)?.abort(new RunCancelledError());
  ctx.inflight.delete(runId);
  return run;
}
