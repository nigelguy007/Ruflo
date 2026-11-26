import { describe, expect, test } from 'vitest';
import {
  agentStep,
  catalogOf,
  deferred,
  makeRig,
  okResult,
  playbook,
  signal,
  untilAborted,
} from './support.js';

const twoOperators = playbook('pair', [
  agentStep('look', 'inspector', { handoffTo: 'fitter' }),
  agentStep('fix', 'fitter'),
]);

describe('agent step', () => {
  test('runs each operator on its own harness and ends the run succeeded', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => [s.stepId, s.status, s.attempt])).toEqual([
      ['look', 'succeeded', 1],
      ['fix', 'succeeded', 1],
    ]);
    expect(run.currentStepId).toBeNull();
    expect(run.stopReason).toBeNull();
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(rig.executors.claude.calls.map((c) => c.step.id)).toEqual(['look']);
    expect(rig.executors.codex.calls.map((c) => c.step.id)).toEqual(['fix']);
    expect(rig.executors.simulated.calls).toHaveLength(0);
  });

  test('always uses the simulated executor in simulate mode', async () => {
    const rig = makeRig({
      catalog: catalogOf({ playbooks: [twoOperators] }),
      config: { mode: 'simulate', workdir: null },
    });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.executors.simulated.calls.map((c) => c.step.id)).toEqual(['look', 'fix']);
    expect(rig.executors.claude.calls).toHaveLength(0);
    expect(rig.executors.codex.calls).toHaveLength(0);
    expect(rig.executors.simulated.calls[0]?.workdir).toBeNull();
  });

  test('hands the executor the signal, what was recalled and what earlier steps concluded', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    rig.executors.claude.script = () => okResult('The cart total divides by zero.');

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    const context = rig.executors.codex.calls[0];
    expect(context?.signal.title).toBe('Checkout page throws on empty cart');
    expect(context?.operator).toMatchObject({ id: 'fitter', status: 'working', currentRunId: 'run_1' });
    expect(context?.recalled).toEqual([
      { key: 'earlier', text: 'Seen something like this before.', score: 0.8 },
    ]);
    expect(context?.prior).toEqual([
      { stepId: 'look', title: 'Do look', summary: 'The cart total divides by zero.' },
    ]);
    expect(context?.workdir).toBe('/srv/checkout');
    expect(context?.run.status).toBe('running');
    expect(rig.coordination.recalls).toEqual([
      { operatorId: 'inspector', query: 'Checkout page throws on empty cart', limit: 3 },
      { operatorId: 'fitter', query: 'Checkout page throws on empty cart', limit: 3 },
    ]);
  });

  test('carries on with nothing recalled when memory is unavailable', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    rig.coordination.failRecall = true;

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
    expect(rig.executors.claude.calls[0]?.recalled).toEqual([]);
  });

  test('records the summary, artifacts, claims and the handoff', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    rig.executors.claude.script = () =>
      okResult('Reproduced with an empty cart.', {
        artifacts: [{ kind: 'log', label: 'Stack trace', value: 'TypeError at cart.ts:12' }],
        claims: [
          { label: 'Reproduced locally', detail: 'Fails on main at 3f9a.', ok: true },
          { label: 'Only affects guests', detail: 'Signed-in carts are never empty.', ok: null },
        ],
        costUsd: 0.42,
      });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.steps[0]?.summary).toBe('Reproduced with an empty cart.');
    const mine = detail.timeline.filter((e) => e.actor === 'inspector');
    expect(mine.map((e) => e.kind)).toEqual(['note', 'note', 'artifact', 'handoff']);
    expect(mine[0]?.text).toBe('Inspector started "Do look".');
    expect(mine[1]).toMatchObject({ text: 'Reproduced with an empty cart.', data: { stepId: 'look', costUsd: 0.42 } });
    expect(mine[2]?.text).toBe('Stack trace: TypeError at cart.ts:12');
    expect(mine[3]).toMatchObject({ mentions: ['fitter'], data: { from: 'inspector', to: 'fitter' } });
    expect(mine[3]?.text).toContain('@fitter');
    expect(detail.evidence.filter((e) => e.stepId === 'look')).toEqual([
      { id: 'evd_1', runId: 'run_1', stepId: 'look', kind: 'claimed', label: 'Reproduced locally', detail: 'Fails on main at 3f9a.', ok: true },
      { id: 'evd_2', runId: 'run_1', stepId: 'look', kind: 'claimed', label: 'Only affects guests', detail: 'Signed-in carts are never empty.', ok: null },
    ]);
  });

  test('marks claims as simulated in simulate mode', async () => {
    const rig = makeRig({
      catalog: catalogOf({ playbooks: [twoOperators] }),
      config: { mode: 'simulate', workdir: null },
    });
    rig.executors.simulated.script = () =>
      okResult('Scripted.', { claims: [{ label: 'Looks fine', detail: 'Scripted claim.', ok: true }] });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.engine.runDetail('run_1').evidence.map((e) => e.kind)).toEqual(['simulated', 'simulated']);
  });

  test('lets every operator that took part remember how the run ended', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.coordination.remembered.map((m) => [m.operatorId, m.key])).toEqual([
      ['inspector', 'run:run_1'],
      ['fitter', 'run:run_1'],
    ]);
    expect(rig.coordination.remembered[0]?.text).toContain('ended succeeded');
    expect(rig.coordination.remembered[0]?.tags).toEqual(['pair', 'succeeded', 'manual', 'manual.run']);
  });

  test('ends the run normally when remembering fails', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    rig.coordination.failRemember = true;

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
    expect(rig.coordination.remembered).toEqual([]);
  });

  test('fails the run when the session reports failure and there are no retries', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    rig.executors.claude.script = () => ({ ...okResult('Could not reproduce it.'), ok: false });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('Inspector could not finish "Do look" after 1 attempt: Could not reproduce it.');
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(run.steps[0]?.summary).toBe('Could not reproduce it');
    expect(rig.executors.codex.calls).toHaveLength(0);
    expect(rig.engine.runDetail('run_1').timeline.at(-1)).toMatchObject({ kind: 'error', actor: 'system' });
  });

  test('retries a failing step and carries on when a later attempt works', async () => {
    const catalog = catalogOf({
      playbooks: [playbook('retry', [agentStep('look', 'inspector', { retries: 2 })])],
    });
    const rig = makeRig({ catalog });
    let attempts = 0;
    rig.executors.claude.script = () => {
      attempts += 1;
      if (attempts < 3) throw new Error('session crashed');
      return okResult('Third time lucky.');
    };

    rig.engine.dispatch(signal(), { playbookId: 'retry' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.status).toBe('succeeded');
    expect(detail.run.steps[0]).toMatchObject({ status: 'succeeded', attempt: 3, summary: 'Third time lucky.' });
    const errors = detail.timeline.filter((e) => e.kind === 'error');
    expect(errors.map((e) => e.text)).toEqual([
      'Attempt 1 of 3 at "Do look" did not finish: session crashed. Trying again.',
      'Attempt 2 of 3 at "Do look" did not finish: session crashed. Trying again.',
    ]);
    expect(detail.timeline.filter((e) => e.text.includes('started')).map((e) => e.text)).toEqual([
      'Inspector started "Do look".',
      'Inspector started "Do look" (attempt 2).',
      'Inspector started "Do look" (attempt 3).',
    ]);
  });

  test('retries up to the limit and then fails the run', async () => {
    const catalog = catalogOf({
      playbooks: [playbook('retry', [agentStep('look', 'inspector', { retries: 1 }), agentStep('fix', 'fitter')])],
    });
    const rig = makeRig({ catalog });
    rig.executors.claude.script = () => {
      throw new Error('session crashed.');
    };

    rig.engine.dispatch(signal(), { playbookId: 'retry' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(rig.executors.claude.calls).toHaveLength(2);
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('Inspector could not finish "Do look" after 2 attempts: session crashed.');
    expect(run.steps.map((s) => [s.status, s.attempt])).toEqual([
      ['failed', 2],
      ['skipped', 0],
    ]);
  });

  test('treats a result it cannot read as a failed attempt', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    rig.executors.claude.script = () => JSON.parse('{"ok":true,"summary":42}');

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').stopReason).toContain('returned a result the engine could not read');
  });

  test('aborts a session that runs past its timeout and counts it as a failed attempt', async () => {
    const catalog = catalogOf({
      playbooks: [playbook('slow', [agentStep('look', 'inspector', { timeoutSeconds: 30 })])],
    });
    const rig = makeRig({ catalog });
    const started = deferred();
    let aborted = false;
    rig.executors.claude.script = (_ctx, abort) => {
      abort.addEventListener('abort', () => {
        aborted = true;
      });
      started.resolve();
      return untilAborted(abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'slow' });
    await started.promise;
    rig.time.advance(29_999);
    const before = rig.run('run_1').status;
    rig.time.advance(1);
    await rig.engine.whenIdle();

    expect(before).toBe('running');
    expect(aborted).toBe(true);
    expect(rig.run('run_1').stopReason).toBe(
      'Inspector could not finish "Do look" after 1 attempt: timed out after 30 seconds.',
    );
  });

  test('gives a step 600 seconds when it sets no timeout', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    const started = deferred();
    rig.executors.claude.script = (_ctx, abort) => {
      started.resolve();
      return untilAborted(abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await started.promise;
    rig.time.advance(599_999);
    const before = rig.run('run_1').status;
    rig.time.advance(1);
    await rig.engine.whenIdle();

    expect(before).toBe('running');
    expect(rig.run('run_1').stopReason).toContain('timed out after 600 seconds');
  });

  test('does not leave a timer behind once a step has finished', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });

    rig.engine.dispatch(signal(), { playbookId: 'pair' });
    await rig.engine.whenIdle();

    expect(rig.time.sleepers()).toBe(0);
  });

  test('stops with a clear reason when the operator has disappeared from the config', async () => {
    const before = makeRig({ catalog: catalogOf({ playbooks: [twoOperators] }) });
    before.engine.setPaused(true);
    before.engine.dispatch(signal(), { playbookId: 'pair' });
    await before.engine.whenIdle();
    const after = makeRig({
      catalog: catalogOf({ operators: [], playbooks: [] }),
      store: before.store,
      time: before.time,
    });

    after.engine.setPaused(false);
    await after.engine.whenIdle();

    expect(after.run('run_1').stopReason).toBe(
      'Stopped before "Do look": operator "inspector" no longer exists.',
    );
  });
});
