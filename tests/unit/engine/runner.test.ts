import { describe, expect, test } from 'vitest';
import { agentStep, catalogOf, makeRig, playbook, signal } from './support.js';
import type { Rig } from './support.js';

const pair = playbook('pair', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')]);

/** A run that is queued behind the pause, so its stored state can be tampered with before it moves. */
async function heldRun(): Promise<Rig> {
  const rig = makeRig({ catalog: catalogOf({ playbooks: [pair] }) });
  rig.engine.setPaused(true);
  rig.engine.dispatch(signal(), { playbookId: 'pair' });
  await rig.engine.whenIdle();
  return rig;
}

describe('runner', () => {
  test('fails a run whose stored playbook has fewer steps than the run', async () => {
    const rig = await heldRun();
    const shorter = { ...pair, steps: pair.steps.slice(0, 1) };
    rig.store.db.prepare('UPDATE runs SET playbook = ? WHERE id = ?').run(JSON.stringify(shorter), 'run_1');
    rig.store.runs.updateStep('run_1', 'look', { status: 'succeeded' });

    rig.engine.setPaused(false);
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('Stopped: the playbook stored with this run can no longer be read.');
  });

  test('fails a run it cannot advance at all instead of leaving it running', async () => {
    const rig = await heldRun();
    rig.store.db.prepare("UPDATE runs SET playbook = '{\"broken\":true}' WHERE id = ?").run('run_1');

    rig.engine.setPaused(false);
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe(
      'Stopped: Switchyard hit an internal error while advancing this run. The details are in the server log.',
    );
    expect(rig.executors.claude.calls).toHaveLength(0);
  });

  test('ends a run with every step done as succeeded', async () => {
    const rig = await heldRun();
    rig.store.runs.updateStep('run_1', 'look', { status: 'succeeded' });
    rig.store.runs.updateStep('run_1', 'fix', { status: 'succeeded' });

    rig.engine.setPaused(false);
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
    expect(rig.executors.claude.calls).toHaveLength(0);
  });
});
