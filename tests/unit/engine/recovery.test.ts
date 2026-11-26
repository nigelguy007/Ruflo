import { describe, expect, test } from 'vitest';
import { agentStep, catalogOf, deferred, gateStep, makeRig, playbook, signal, untilAborted } from './support.js';
import type { Rig } from './support.js';

const pair = playbook('pair', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')]);
const gated = playbook('gated', [agentStep('look', 'inspector'), gateStep('approve'), agentStep('fix', 'fitter')]);

function rig(): Rig {
  return makeRig({ catalog: catalogOf({ playbooks: [pair, gated] }) });
}

/** Starts a run whose first step never comes back, as if the process died during it. */
async function crashDuringFirstStep(r: Rig): Promise<void> {
  const started = deferred();
  r.executors.claude.script = (_ctx, abort) => {
    started.resolve();
    return untilAborted(abort);
  };
  r.engine.dispatch(signal(), { playbookId: 'pair' });
  await started.promise;
}

describe('recovery', () => {
  test('reruns the step a crash interrupted and finishes the run', async () => {
    const before = rig();
    await crashDuringFirstStep(before);
    const crashed = before.run('run_1');

    const after = before.restart();
    const recovered = after.engine.recover();
    await after.engine.whenIdle();

    expect(crashed.status).toBe('running');
    expect(crashed.steps[0]?.status).toBe('running');
    expect(recovered).toBe(1);
    const run = after.run('run_1');
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => [s.stepId, s.status, s.attempt])).toEqual([
      ['look', 'succeeded', 2],
      ['fix', 'succeeded', 1],
    ]);
    expect(after.executors.claude.calls.map((c) => c.step.id)).toEqual(['look']);
    const notes = after.engine.runDetail('run_1').timeline.map((e) => e.text);
    expect(notes).toContain('Switchyard restarted while "Do look" was in progress. The step starts again from the beginning.');
    expect(after.engine.verifyLedger()).toMatchObject({ ok: true, brokenAt: null });
  });

  test('leaves a run untouched by a clean shutdown, so the next boot picks it up', async () => {
    const before = rig();
    let abortedWith: unknown = null;
    const started = deferred();
    before.executors.claude.script = (_ctx, abort) => {
      abort.addEventListener('abort', () => {
        abortedWith = abort.reason;
      });
      started.resolve();
      return untilAborted(abort);
    };
    before.engine.dispatch(signal(), { playbookId: 'pair' });
    await started.promise;

    await before.engine.shutdown();
    const stopped = before.run('run_1');
    const after = before.restart();
    after.engine.recover();
    await after.engine.whenIdle();

    expect(abortedWith).toMatchObject({ name: 'AbortError', message: 'Switchyard is shutting down.' });
    expect(stopped.status).toBe('running');
    expect(stopped.stopReason).toBeNull();
    expect(before.engine.runDetail('run_1').timeline.some((e) => e.kind === 'error')).toBe(false);
    expect(after.run('run_1').status).toBe('succeeded');
  });

  test('puts back a queued run with a note, and keeps it parked while the pause lasts', async () => {
    const before = rig();
    before.engine.setPaused(true);
    before.engine.dispatch(signal(), { playbookId: 'pair' });
    await before.engine.whenIdle();

    const after = before.restart();
    const recovered = after.engine.recover();
    await after.engine.whenIdle();
    const held = after.run('run_1');
    after.engine.setPaused(false);
    await after.engine.whenIdle();

    expect(recovered).toBe(1);
    expect(held.status).toBe('queued');
    expect(after.engine.runDetail('run_1').timeline.map((e) => e.text)).toContain(
      'Switchyard restarted. This run is back in the queue and carries on from where it stopped.',
    );
    expect(after.run('run_1').status).toBe('succeeded');
  });

  test('leaves a run waiting for a person alone, and the answer still resumes it', async () => {
    const before = rig();
    before.engine.dispatch(signal(), { playbookId: 'gated' });
    await before.engine.whenIdle();

    const after = before.restart();
    const recovered = after.engine.recover();
    after.engine.decide('dec_1', 'approve', null, 'human');
    await after.engine.whenIdle();

    expect(recovered).toBe(0);
    expect(after.run('run_1').status).toBe('succeeded');
    expect(after.executors.codex.calls.map((c) => c.step.id)).toEqual(['fix']);
  });

  test('has nothing to do after runs that ended', async () => {
    const before = rig();
    before.engine.dispatch(signal(), { playbookId: 'pair' });
    await before.engine.whenIdle();

    expect(before.restart().engine.recover()).toBe(0);
  });
});
