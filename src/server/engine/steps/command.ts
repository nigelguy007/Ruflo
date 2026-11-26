import type { CommandStep, EvidenceKind } from '../../../shared/types.js';
import { errorMessage } from '../../logger.js';
import type { CommandResult } from '../../ports.js';
import { SYSTEM_ACTOR } from '../context.js';
import type { EngineContext } from '../context.js';
import { BudgetExhaustedError, StepTimeoutError } from '../errors.js';
import { failRun, saveStep } from '../run-state.js';
import { clipText } from '../text.js';
import { iso } from '../time.js';
import {
  beginStep,
  DEFAULT_TIMEOUT_SECONDS,
  pace,
  releaseStep,
  stillCurrent,
  tail,
  withDeadline,
} from './shared.js';
import type { StepFrame, StepOutcome } from './shared.js';

const OUTPUT_TAIL_LENGTH = 2_000;
const REASON_LENGTH = 300;
const SECOND_MS = 1_000;
/** The runner enforces the timeout itself; the engine's own deadline is a backstop just behind it. */
const BACKSTOP_SECONDS = 5;

/** The argv as a person would type it. For display only: nothing is ever run through a shell. */
export function displayCommand(argv: readonly string[]): string {
  return argv.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function timeoutOf(step: CommandStep): number {
  return step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
}

function describeExit(step: CommandStep, result: CommandResult): string {
  if (result.timedOut) return `timed out after ${timeoutOf(step)} seconds`;
  const expected = step.expectExit === undefined ? '' : ` (expected ${step.expectExit})`;
  return `exit code ${result.exitCode}${expected}`;
}

function verdict(step: CommandStep, result: CommandResult): boolean | null {
  if (result.timedOut) return false;
  return step.expectExit === undefined ? null : result.exitCode === step.expectExit;
}

function stopReasonFor(step: CommandStep, command: string, result: CommandResult): string {
  if (result.timedOut) return `\`${command}\` did not finish within ${timeoutOf(step)} seconds.`;
  return `\`${command}\` exited with code ${result.exitCode}; the playbook expects ${step.expectExit ?? 0}.`;
}

/** What the ledger entry for a command keeps besides its text. */
function commandData(step: CommandStep, result: CommandResult): Record<string, unknown> {
  return {
    stepId: step.id,
    argv: step.run,
    exitCode: result.exitCode,
    dryRun: result.dryRun,
    timedOut: result.timedOut,
    ...(result.executed === false ? { executed: false } : {}),
  };
}

/** The runner's own words for why nothing ran, on one line and without a closing full stop. */
function whyNotRun(result: CommandResult): string {
  const flat = clipText(result.output.replace(/\s+/g, ' ').trim(), REASON_LENGTH).replace(/[.\s]+$/, '');
  return flat.length > 0 ? flat : 'no reason was given';
}

/**
 * The runner refused the command, could not start it, or had nowhere to run
 * it. No process returned the exit code, so there is nothing to verify: the
 * evidence says the command was not run (and is never `verified`) and the step
 * fails whatever the playbook expected.
 */
function recordNotRun(
  ctx: EngineContext,
  frame: StepFrame<CommandStep>,
  command: string,
  result: CommandResult,
): StepOutcome {
  const { run, step } = frame;
  const reason = whyNotRun(result);
  const summary = `Did not run \`${command}\`: ${reason}.`;
  ctx.store.transaction(() => {
    ctx.store.evidence.insert({
      id: ctx.newId('evd'),
      runId: run.id,
      stepId: step.id,
      kind: 'simulated',
      label: `${step.title} (not run)`,
      detail: [`$ ${command}`, 'not run: nothing was executed', tail(result.output.trim(), OUTPUT_TAIL_LENGTH)]
        .filter((line) => line.length > 0)
        .join('\n'),
      ok: false,
    });
    ctx.ledger.append({
      runId: run.id,
      actor: SYSTEM_ACTOR,
      kind: 'command',
      text: summary,
      data: commandData(step, result),
    });
    failRun(ctx, run.id, `\`${command}\` could not be run: ${reason}.`, { stepId: step.id, summary });
  });
  return 'halt';
}

/** Writes down what the engine saw. This is the only place `verified` evidence comes from. */
function recordResult(
  ctx: EngineContext,
  frame: StepFrame<CommandStep>,
  command: string,
  result: CommandResult,
): StepOutcome {
  if (result.executed === false) return recordNotRun(ctx, frame, command, result);
  const { run, step } = frame;
  const ok = verdict(step, result);
  const kind: EvidenceKind = result.dryRun ? 'simulated' : 'verified';
  const exit = describeExit(step, result);
  const output = tail(result.output.trim(), OUTPUT_TAIL_LENGTH);
  const summary = result.dryRun
    ? `Dry run of \`${command}\`: nothing was executed.`
    : `Ran \`${command}\`: ${exit}.`;
  ctx.store.transaction(() => {
    ctx.store.evidence.insert({
      id: ctx.newId('evd'),
      runId: run.id,
      stepId: step.id,
      kind,
      label: step.title,
      detail: [`$ ${command}`, exit, output].filter((line) => line.length > 0).join('\n'),
      ok,
    });
    ctx.ledger.append({
      runId: run.id,
      actor: SYSTEM_ACTOR,
      kind: 'command',
      text: summary,
      data: commandData(step, result),
    });
    if (ok === false) {
      failRun(ctx, run.id, stopReasonFor(step, command, result), { stepId: step.id, summary });
    } else {
      saveStep(ctx, run.id, step.id, { status: 'succeeded', finishedAt: iso(ctx.clock()), summary });
    }
  });
  return ok === false ? 'halt' : 'next';
}

function crashReason(step: CommandStep, command: string, error: unknown): string {
  if (error instanceof BudgetExhaustedError) return error.message;
  if (error instanceof StepTimeoutError) return `\`${command}\` did not finish within ${timeoutOf(step)} seconds.`;
  return `\`${command}\` could not be run: ${errorMessage(error).replace(/[.\s]+$/, '')}.`;
}

/** The command could not be run at all, or never came back. */
function recordCrash(
  ctx: EngineContext,
  frame: StepFrame<CommandStep>,
  command: string,
  error: unknown,
): StepOutcome {
  const { run, step } = frame;
  const reason = crashReason(step, command, error);
  failRun(ctx, run.id, reason, { stepId: step.id, summary: reason });
  return 'halt';
}

/** Runs one command step. The engine runs the argv itself, so the exit code is something it saw. */
export async function runCommandStep(
  ctx: EngineContext,
  frame: StepFrame<CommandStep>,
): Promise<StepOutcome> {
  const { step } = frame;
  const command = displayCommand(step.run);
  const { run, abort, budget } = beginStep(ctx, frame);
  const current = { ...frame, run };
  try {
    await pace(ctx, abort);
    if (!stillCurrent(ctx, run.id, step.id)) return 'halt';
    const seconds = timeoutOf(step);
    let result: CommandResult;
    try {
      result = await withDeadline(
        ctx,
        abort,
        seconds + BACKSTOP_SECONDS,
        () =>
          ctx.commandRunner.run([...step.run], {
            cwd: ctx.config.workdir,
            timeoutMs: seconds * SECOND_MS,
            abort: abort.signal,
          }),
        budget,
      );
    } catch (error) {
      return stillCurrent(ctx, run.id, step.id) ? recordCrash(ctx, current, command, error) : 'halt';
    }
    return stillCurrent(ctx, run.id, step.id) ? recordResult(ctx, current, command, result) : 'halt';
  } finally {
    releaseStep(ctx, run.id, abort);
  }
}
