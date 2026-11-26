import { describe, expect, test } from 'vitest';
import {
  agentStep,
  catalogOf,
  deferred,
  gateStep,
  makeRig,
  MINUTE,
  okResult,
  playbook,
  signal,
} from './support.js';

const gated = playbook('gated', [agentStep('look', 'inspector'), gateStep('approve'), agentStep('fix', 'fitter')]);

describe('overview', () => {
  test('shows an operator working on its step, and the other idle', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });
    const started = deferred();
    const finish = deferred();
    rig.executors.claude.script = async () => {
      started.resolve();
      await finish.promise;
      return okResult();
    };
    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await started.promise;

    const operators = rig.engine.operators();
    finish.resolve();
    await rig.engine.whenIdle();

    expect(operators.map((o) => [o.id, o.status, o.currentRunId, o.currentActivity])).toEqual([
      ['inspector', 'working', 'run_1', 'Do look'],
      ['fitter', 'idle', null, null],
    ]);
  });

  test('shows the operator whose work sits in front of an open gate as waiting', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });
    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await rig.engine.whenIdle();

    const overview = rig.engine.overview();

    expect(overview.operators.map((o) => [o.id, o.status, o.currentActivity])).toEqual([
      ['inspector', 'waiting', 'Waiting for a decision: Decide approve'],
      ['fitter', 'idle', null],
    ]);
    expect(overview).toMatchObject({ openDecisions: 1, activeRuns: 1, failedRuns: 0 });
    expect(overview.lastSignalAt).toBe('2026-11-26T12:00:00.000Z');
  });

  test('sums up the last day: what finished, what failed, and what nobody had to look at', async () => {
    const quick = playbook('quick', [agentStep('look', 'inspector')]);
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated, quick] }) });
    rig.engine.dispatch(signal({ fingerprint: 'a' }), { playbookId: 'quick' });
    rig.engine.dispatch(signal({ fingerprint: 'b' }), { playbookId: 'gated' });
    await rig.engine.whenIdle();
    rig.engine.decide('dec_1', 'approve', null, 'human');
    await rig.engine.whenIdle();
    rig.executors.claude.script = () => ({ ...okResult('No.'), ok: false });
    rig.engine.dispatch(signal({ fingerprint: 'c' }), { playbookId: 'quick' });
    await rig.engine.whenIdle();

    const today = rig.engine.overview();
    rig.time.advance(25 * 60 * MINUTE);
    const tomorrow = rig.engine.overview();

    expect(today.digest).toEqual({
      since: '2026-11-25T12:00:00.000Z',
      handledWithoutYou: 1,
      decisionsMade: 1,
      succeeded: 2,
      failed: 1,
      rejected: 0,
      cancelled: 0,
    });
    expect(today.failedRuns).toBe(1);
    expect(tomorrow.digest).toMatchObject({ succeeded: 0, failed: 0, decisionsMade: 0, handledWithoutYou: 0 });
  });
});
