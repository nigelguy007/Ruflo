import { describe, expect, test } from 'vitest';
import { EngineError } from '../../../src/server/engine/index.js';
import {
  agentStep,
  catalogOf,
  commandStep,
  deferred,
  gateStep,
  makeRig,
  okResult,
  playbook,
  signal,
  untilAborted,
} from './support.js';
import type { Rig } from './support.js';

const pair = playbook('pair', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')]);
const gated = playbook('gated', [agentStep('look', 'inspector'), gateStep('approve'), agentStep('fix', 'fitter')]);
const command = playbook('command', [commandStep('tests', ['npm', 'test'])]);

function rigFor(...playbooks: ReturnType<typeof playbook>[]): Rig {
  return makeRig({ catalog: catalogOf({ playbooks }) });
}

function caught(action: () => unknown): EngineError {
  try {
    action();
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error('expected an EngineError');
}

describe('cancel', () => {
  test('aborts the agent step in flight and ends the run as cancelled', async () => {
    const rig = rigFor(pair);
    const started = deferred();
    let reason: unknown = null;
    rig.executors.claude.script = (_ctx, abort) => {
      abort.addEventListener('abort', () => {
        reason = abort.reason;
      });
      started.resolve();
      return untilAborted(abort);
    };
    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await started.promise;

    const returned = rig.engine.cancel('run_1');
    await rig.engine.whenIdle();

    expect(returned).toMatchObject({ status: 'cancelled', stopReason: 'Cancelled by a person.', currentStepId: null });
    expect(reason).toMatchObject({ name: 'AbortError', message: 'The run was cancelled.' });
    const run = rig.run('run_1');
    expect(run.status).toBe('cancelled');
    expect(run.finishedAt).not.toBeNull();
    expect(run.steps.map((s) => [s.status, s.summary])).toEqual([
      ['skipped', null],
      ['skipped', null],
    ]);
    expect(rig.executors.codex.calls).toHaveLength(0);
    const timeline = rig.engine.runDetail('run_1').timeline;
    expect(timeline.filter((e) => e.kind === 'error')).toEqual([]);
    expect(timeline.at(-1)).toMatchObject({ actor: 'system', kind: 'system', text: 'Run cancelled.' });
    expect(rig.events.filter((e) => e.type === 'run.updated').at(-1)).toMatchObject({ run: { status: 'cancelled' } });
  });

  test('discards whatever a step that ignores the abort returns afterwards', async () => {
    const rig = rigFor(pair);
    const started = deferred();
    const late = deferred<ReturnType<typeof okResult>>();
    rig.executors.claude.script = () => {
      started.resolve();
      return late.promise;
    };
    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await started.promise;

    rig.engine.cancel('run_1');
    late.resolve(okResult('Finished anyway.'));
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('cancelled');
    expect(rig.run('run_1').steps[0]?.summary).toBeNull();
    expect(rig.engine.runDetail('run_1').timeline.some((e) => e.text === 'Finished anyway.')).toBe(false);
  });

  test('aborts a command in flight', async () => {
    const rig = rigFor(command);
    const started = deferred();
    rig.commands.script = (_argv, opts) => {
      started.resolve();
      return untilAborted(opts.abort);
    };
    rig.engine.dispatch(signal(), { playbookId: 'command' });
    await started.promise;

    rig.engine.cancel('run_1');
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('cancelled');
    expect(rig.engine.runDetail('run_1').evidence).toEqual([]);
  });

  test('closes the open decision of a run waiting at a gate', async () => {
    const rig = rigFor(gated);
    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await rig.engine.whenIdle();

    rig.engine.cancel('run_1');
    await rig.engine.whenIdle();

    const decision = rig.store.decisions.get('dec_1');
    expect(decision).toMatchObject({
      status: 'rejected',
      decidedBy: 'system',
      note: 'Closed without an answer because the run was cancelled.',
    });
    expect(rig.events.filter((e) => e.type === 'decision.resolved')).toHaveLength(1);
    expect(rig.engine.overview().openDecisions).toBe(0);
    expect(rig.run('run_1').steps.map((s) => s.status)).toEqual(['succeeded', 'skipped', 'skipped']);
    expect(caught(() => rig.engine.decide('dec_1', 'approve', null, 'human')).code).toBe('conflict');
    expect(rig.executors.codex.calls).toHaveLength(0);
  });

  test('cancels a run held back by the pause, which then never starts', async () => {
    const rig = rigFor(pair);
    rig.engine.setPaused(true);
    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    rig.engine.cancel('run_1');
    rig.engine.setPaused(false);
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('cancelled');
    expect(rig.executors.claude.calls).toHaveLength(0);
    expect(rig.store.runs.listParked()).toEqual([]);
  });

  test('refuses a run that has already ended, and one that does not exist', async () => {
    const rig = rigFor(pair);
    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    const ended = caught(() => rig.engine.cancel('run_1'));
    const missing = caught(() => rig.engine.cancel('run_404'));

    expect(ended.code).toBe('conflict');
    expect(ended.message).toBe('This run has already ended (succeeded).');
    expect(missing.code).toBe('not_found');
  });
});
