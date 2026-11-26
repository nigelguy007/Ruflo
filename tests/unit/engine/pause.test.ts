import { describe, expect, test } from 'vitest';
import { agentStep, catalogOf, deferred, gateStep, makeRig, okResult, playbook, signal } from './support.js';

const PAUSED_NOTE =
  'Paused: Switchyard is globally paused, so no new step will start. This run continues when the pause is lifted.';
const pair = playbook('pair', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')]);

function rig(): ReturnType<typeof makeRig> {
  return makeRig({ catalog: catalogOf({ playbooks: [pair] }) });
}

describe('global pause', () => {
  test('parks a new run before its first step and says so once', async () => {
    const r = rig();

    const settings = r.engine.setPaused(true);
    r.engine.dispatch(signal(), { playbookId: 'pair' });
    await r.engine.whenIdle();
    r.engine.setPaused(true);
    await r.engine.whenIdle();

    expect(settings).toEqual({ paused: true, mode: 'live' });
    expect(r.run('run_1').status).toBe('queued');
    expect(r.store.runs.meta('run_1')?.parked).toBe(true);
    expect(r.executors.claude.calls).toHaveLength(0);
    const notes = r.engine.runDetail('run_1').timeline.filter((e) => e.text === PAUSED_NOTE);
    expect(notes).toHaveLength(1);
    expect(r.engine.operators().map((o) => o.status)).toEqual(['paused', 'paused']);
  });

  test('resumes every parked run when the pause is lifted', async () => {
    const r = rig();
    r.engine.setPaused(true);
    r.engine.dispatch(signal(), { playbookId: 'pair' });
    r.engine.dispatch(signal({ fingerprint: 'another' }), { playbookId: 'pair' });
    await r.engine.whenIdle();

    r.engine.setPaused(false);
    await r.engine.whenIdle();

    expect(r.run('run_1').status).toBe('succeeded');
    expect(r.run('run_2').status).toBe('succeeded');
    expect(r.store.runs.meta('run_1')?.parked).toBe(false);
    expect(r.engine.operators().map((o) => o.status)).toEqual(['idle', 'idle']);
  });

  test('lets the step in flight finish but starts no new one', async () => {
    const r = rig();
    const started = deferred();
    const finish = deferred();
    r.executors.claude.script = async () => {
      started.resolve();
      await finish.promise;
      return okResult('Looked.');
    };
    r.engine.dispatch(signal(), { playbookId: 'pair' });
    await started.promise;

    r.engine.setPaused(true);
    finish.resolve();
    await r.engine.whenIdle();
    const held = r.run('run_1');
    r.engine.setPaused(false);
    await r.engine.whenIdle();

    expect(held.status).toBe('queued');
    expect(held.steps.map((s) => s.status)).toEqual(['succeeded', 'pending']);
    expect(r.run('run_1').status).toBe('succeeded');
    expect(r.executors.codex.calls).toHaveLength(1);
  });

  test('announces a change of setting, and only a change', () => {
    const r = rig();

    r.engine.setPaused(true);
    r.engine.setPaused(true);
    r.engine.setPaused(false);
    r.engine.setPaused(false);

    const announced = r.events.filter((e) => e.type === 'settings.updated');
    expect(announced).toEqual([
      { type: 'settings.updated', settings: { paused: true, mode: 'live' } },
      { type: 'settings.updated', settings: { paused: false, mode: 'live' } },
    ]);
    expect(r.engine.settings()).toEqual({ paused: false, mode: 'live' });
  });

  test('holds back a run that a person resumes at a gate while paused', async () => {
    const gated = playbook('gated', [agentStep('look', 'inspector'), gateStep('ok'), agentStep('fix', 'fitter')]);
    const r = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });
    r.engine.dispatch(signal(), { playbookId: 'gated' });
    await r.engine.whenIdle();

    r.engine.setPaused(true);
    r.engine.decide('dec_1', 'approve', null, 'human');
    await r.engine.whenIdle();
    const held = r.run('run_1');
    r.engine.setPaused(false);
    await r.engine.whenIdle();

    expect(held.status).toBe('queued');
    expect(r.executors.codex.calls).toHaveLength(1);
    expect(r.run('run_1').status).toBe('succeeded');
  });
});
