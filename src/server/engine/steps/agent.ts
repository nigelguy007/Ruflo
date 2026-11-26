import type { OperatorConfig } from '../../../shared/schemas.js';
import type { AgentStep, EvidenceKind, Run, Signal } from '../../../shared/types.js';
import { errorMessage } from '../../logger.js';
import type { Executor, MemoryHit, StepContext, StepResult } from '../../ports.js';
import type { EngineContext } from '../context.js';
import { recallFor } from '../memory.js';
import { failRun, saveStep } from '../run-state.js';
import { iso } from '../time.js';
import { stepResultSchema } from './result.js';
import {
  beginStep,
  DEFAULT_TIMEOUT_SECONDS,
  pace,
  releaseStep,
  stillCurrent,
  withDeadline,
} from './shared.js';
import type { StepFrame, StepOutcome } from './shared.js';

const MAX_REASON_LENGTH = 500;

type Attempt = { ok: true; result: StepResult } | { ok: false; reason: string };

/** In simulate mode every operator is scripted, whatever harness it is configured for. */
function pickExecutor(ctx: EngineContext, operator: OperatorConfig): Executor {
  return ctx.config.mode === 'simulate' ? ctx.executors.simulated : ctx.executors[operator.harness];
}

function plain(reason: string): string {
  const trimmed = reason.trim().replace(/[.\s]+$/, '');
  return (trimmed.length > 0 ? trimmed : 'no reason was given').slice(0, MAX_REASON_LENGTH);
}

function buildStepContext(
  ctx: EngineContext,
  run: Run,
  step: AgentStep,
  operator: OperatorConfig,
  signal: Signal,
  recalled: MemoryHit[],
): StepContext {
  const prior = run.steps.flatMap((s) =>
    s.status === 'succeeded' && s.summary !== null
      ? [{ stepId: s.stepId, title: s.title, summary: s.summary }]
      : [],
  );
  return {
    run,
    step,
    operator: { ...operator, status: 'working', currentRunId: run.id, currentActivity: step.title },
    signal,
    recalled,
    prior,
    workdir: ctx.config.mode === 'simulate' ? null : ctx.config.workdir,
  };
}

async function attemptStep(
  ctx: EngineContext,
  executor: Executor,
  stepContext: StepContext,
  abort: AbortController,
): Promise<Attempt> {
  const seconds = stepContext.step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  try {
    const raw = await withDeadline(ctx, abort, seconds, () => executor.run(stepContext, abort.signal));
    const parsed = stepResultSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'the session returned a result the engine could not read' };
    if (!parsed.data.ok) return { ok: false, reason: plain(parsed.data.summary) };
    return { ok: true, result: parsed.data };
  } catch (error) {
    return { ok: false, reason: plain(errorMessage(error)) };
  }
}

function recordHandoff(ctx: EngineContext, run: Run, step: AgentStep, operator: OperatorConfig): void {
  if (step.handoffTo === undefined) return;
  const target = ctx.catalog.operator(step.handoffTo);
  ctx.ledger.append({
    runId: run.id,
    actor: operator.id,
    kind: 'handoff',
    text: `${operator.name} handed off to ${target?.handle ?? `@${step.handoffTo}`} after "${step.title}".`,
    mentions: [step.handoffTo],
    data: { stepId: step.id, from: operator.id, to: step.handoffTo },
  });
  ctx.store.runs.update(run.id, { addHandoffs: 1 });
}

/** Stores everything a finished session produced. Agent claims are never recorded as verified. */
function recordSuccess(
  ctx: EngineContext,
  frame: StepFrame<AgentStep>,
  operator: OperatorConfig,
  result: StepResult,
): StepOutcome {
  const { run, step } = frame;
  const kind: EvidenceKind = ctx.config.mode === 'simulate' ? 'simulated' : 'claimed';
  const summary = result.summary.trim() || `${operator.name} finished "${step.title}".`;
  ctx.store.transaction(() => {
    ctx.ledger.append({
      runId: run.id,
      actor: operator.id,
      kind: 'note',
      text: summary,
      data: { stepId: step.id, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }) },
    });
    for (const artifact of result.artifacts) {
      ctx.ledger.append({
        runId: run.id,
        actor: operator.id,
        kind: 'artifact',
        text: `${artifact.label}: ${artifact.value}`,
        data: { stepId: step.id, artifact },
      });
    }
    for (const claim of result.claims) {
      ctx.store.evidence.insert({ id: ctx.newId('evd'), runId: run.id, stepId: step.id, kind, ...claim });
    }
    recordHandoff(ctx, run, step, operator);
    saveStep(ctx, run.id, step.id, { status: 'succeeded', finishedAt: iso(ctx.clock()), summary });
  });
  return 'next';
}

/** Retries while the step has attempts left; after that the step and the run fail. */
function recordFailure(
  ctx: EngineContext,
  frame: StepFrame<AgentStep>,
  operator: OperatorConfig,
  attempt: number,
  reason: string,
): StepOutcome {
  const { run, step } = frame;
  const allowed = (step.retries ?? 0) + 1;
  const finishedAt = iso(ctx.clock());
  if (attempt < allowed) {
    ctx.ledger.append({
      runId: run.id,
      actor: operator.id,
      kind: 'error',
      text: `Attempt ${attempt} of ${allowed} at "${step.title}" did not finish: ${reason}. Trying again.`,
      data: { stepId: step.id, attempt },
    });
    saveStep(ctx, run.id, step.id, { status: 'pending', finishedAt });
    return 'next';
  }
  saveStep(ctx, run.id, step.id, { status: 'failed', finishedAt, summary: reason });
  const attempts = attempt === 1 ? '1 attempt' : `${attempt} attempts`;
  failRun(ctx, run.id, `${operator.name} could not finish "${step.title}" after ${attempts}: ${reason}.`);
  return 'halt';
}

/** Runs one agent step: an operator works in a session, and the engine records what came back. */
export async function runAgentStep(
  ctx: EngineContext,
  frame: StepFrame<AgentStep>,
): Promise<StepOutcome> {
  const { step } = frame;
  const operator = ctx.catalog.operator(step.operator);
  const signal = ctx.store.signals.get(frame.run.signalId);
  if (!operator || !signal) {
    const missing = operator ? 'the signal that started this run' : `operator "${step.operator}"`;
    failRun(ctx, frame.run.id, `Stopped before "${step.title}": ${missing} no longer exists.`);
    return 'halt';
  }
  const { run, attempt, abort } = beginStep(ctx, frame);
  try {
    ctx.ledger.append({
      runId: run.id,
      actor: operator.id,
      kind: 'note',
      text: `${operator.name} started "${step.title}"${attempt > 1 ? ` (attempt ${attempt})` : ''}.`,
      data: { stepId: step.id, attempt },
    });
    await pace(ctx, abort);
    const recalled = await recallFor(ctx, operator.id, signal);
    if (!stillCurrent(ctx, run.id, step.id)) return 'halt';
    const stepContext = buildStepContext(ctx, run, step, operator, signal, recalled);
    const outcome = await attemptStep(ctx, pickExecutor(ctx, operator), stepContext, abort);
    if (!stillCurrent(ctx, run.id, step.id)) return 'halt';
    return outcome.ok
      ? recordSuccess(ctx, { ...frame, run }, operator, outcome.result)
      : recordFailure(ctx, { ...frame, run }, operator, attempt, outcome.reason);
  } finally {
    releaseStep(ctx, run.id, abort);
  }
}
