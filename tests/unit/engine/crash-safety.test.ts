import { describe, expect, test } from 'vitest';
import type { Store } from '../../../src/server/db/index.js';
import {
  agentStep,
  catalogOf,
  commandResult,
  commandStep,
  deferred,
  gateStep,
  makeRig,
  okResult,
  playbook,
  signal,
  START,
  untilAborted,
} from './support.js';
import type { Rig } from './support.js';

const checked = playbook('checked', [
  commandStep('tests', ['npm', 'test'], { expectExit: 0 }),
  agentStep('ship', 'inspector'),
]);
const gated = playbook('gated', [agentStep('look', 'inspector'), gateStep('approve'), agentStep('fix', 'fitter')]);
const solo = playbook('solo', [agentStep('look', 'inspector')]);

function rigFor(...playbooks: ReturnType<typeof playbook>[]): Rig {
  return makeRig({ catalog: catalogOf({ playbooks }) });
}

/** Makes the database refuse to record a ledger entry of this kind, as a full disk or a crash would. */
function refuseLedgerEntries(store: Store, kind: string): void {
  store.db.exec(
    `CREATE TRIGGER refuse_${kind} BEFORE INSERT ON timeline WHEN NEW.kind = '${kind}'
     BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
  );
}

function allowLedgerEntries(store: Store, kind: string): void {
  store.db.exec(`DROP TRIGGER refuse_${kind}`);
}

/** The state a process leaves behind when it dies after the step failed and before the run did. */
function leaveCrashedState(rig: Rig): void {
  rig.store.runs.update('run_1', { status: 'running', startedAt: START });
  rig.store.runs.updateStep('run_1', 'tests', {
    status: 'failed',
    attempt: 1,
    startedAt: START,
    finishedAt: START,
    summary: 'Ran `npm test`: exit code 1 (expected 0).',
  });
}

describe('a failed step and its run end together', () => {
  test('a command step that fails is never left failed inside a run that is still going', async () => {
    const rig = rigFor(checked);
    rig.commands.script = () => commandResult({ exitCode: 1, output: '2 failed' });
    refuseLedgerEntries(rig.store, 'error');

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    const failedStep = run.steps.some((s) => s.status === 'failed');
    expect(run.status === 'running' && failedStep).toBe(false);
    expect(failedStep).toBe(run.status === 'failed');
  });

  test('an agent step that fails is never left failed inside a run that is still going', async () => {
    const rig = rigFor(solo);
    rig.executors.claude.script = () => {
      throw new Error('session crashed');
    };
    refuseLedgerEntries(rig.store, 'error');

    rig.engine.dispatch(signal(), { playbookId: 'solo' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    const failedStep = run.steps.some((s) => s.status === 'failed');
    expect(run.status === 'running' && failedStep).toBe(false);
    expect(failedStep).toBe(run.status === 'failed');
  });

  test('a command that could not be run is never left failed inside a run that is still going', async () => {
    const rig = rigFor(checked);
    rig.commands.script = () => {
      throw new Error('spawn failed');
    };
    refuseLedgerEntries(rig.store, 'error');

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status === 'running' && run.steps.some((s) => s.status === 'failed')).toBe(false);
  });

  test('after the crash the failed command is run again, and fails the run on its own result', async () => {
    const before = rigFor(checked);
    before.commands.script = () => commandResult({ exitCode: 1, output: '2 failed' });
    refuseLedgerEntries(before.store, 'error');
    before.engine.dispatch(signal(), { playbookId: 'checked' });
    await before.engine.whenIdle();
    allowLedgerEntries(before.store, 'error');

    const after = before.restart();
    after.commands.script = () => commandResult({ exitCode: 1, output: '2 failed' });
    after.engine.recover();
    await after.engine.whenIdle();

    const run = after.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('`npm test` exited with code 1; the playbook expects 0.');
    expect(after.executors.claude.calls).toHaveLength(0);
    expect(after.engine.verifyLedger().ok).toBe(true);
  });

  test('records the failure, its reason and the end of the run all at once when nothing goes wrong', async () => {
    const rig = rigFor(checked);
    rig.commands.script = () => commandResult({ exitCode: 1, output: '2 failed' });

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(detail.timeline.at(-1)).toMatchObject({ kind: 'error', text: detail.run.stopReason });
    expect(rig.events.filter((e) => e.type === 'run.updated').at(-1)).toMatchObject({
      run: { id: 'run_1', status: 'failed' },
    });
  });
});

describe('a run that crashed between its failed step and its end', () => {
  async function crashedRig(): Promise<Rig> {
    const rig = rigFor(checked);
    rig.engine.setPaused(true);
    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();
    leaveCrashedState(rig);
    return rig;
  }

  test('recovery ends it as failed, naming the step, and never runs the step that was still pending', async () => {
    const before = await crashedRig();
    const after = before.restart();

    after.engine.recover();
    await after.engine.whenIdle();

    const run = after.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toContain('"Run tests"');
    expect(run.stopReason).toContain('failed');
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(after.commands.calls).toHaveLength(0);
    expect(after.executors.claude.calls).toHaveLength(0);
    expect(after.engine.runDetail('run_1').timeline.at(-1)).toMatchObject({ kind: 'error', text: run.stopReason });
    expect(after.engine.verifyLedger().ok).toBe(true);
  });

  test('recovery does not count such a run as one it picked up again', async () => {
    const before = await crashedRig();

    expect(before.restart().engine.recover()).toBe(0);
  });

  test('the run loop refuses to continue past a failed step even without recovery', async () => {
    const rig = await crashedRig();

    rig.engine.setPaused(false);
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toContain('"Run tests"');
    expect(rig.commands.calls).toHaveLength(0);
    expect(rig.executors.claude.calls).toHaveLength(0);
  });

  test('the run loop does not end such a run as succeeded when no step is pending', async () => {
    const only = playbook('only', [commandStep('tests', ['npm', 'test'], { expectExit: 0 })]);
    const rig = rigFor(only);
    rig.engine.setPaused(true);
    rig.engine.dispatch(signal(), { playbookId: 'only' });
    await rig.engine.whenIdle();
    leaveCrashedState(rig);

    rig.engine.setPaused(false);
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('failed');
  });

  test('leaves a run waiting at a gate alone', async () => {
    const rig = rigFor(gated);
    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await rig.engine.whenIdle();

    const after = rig.restart();

    expect(after.engine.recover()).toBe(0);
    expect(after.run('run_1').status).toBe('waiting_gate');
  });
});

describe('opening a gate', () => {
  test('never leaves an open decision that the ledger does not know about', async () => {
    const rig = rigFor(gated);
    refuseLedgerEntries(rig.store, 'gate_opened');

    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await rig.engine.whenIdle();

    const opened = rig.store.timeline.forRun('run_1').filter((e) => e.kind === 'gate_opened');
    const open = rig.store.decisions.list({ status: 'open', limit: 10 });
    expect(open.filter((d) => !opened.some((e) => e.data?.['decisionId'] === d.id))).toEqual([]);
    expect(rig.run('run_1').status).not.toBe('waiting_gate');
  });

  test('records the question and the ledger entry together when nothing goes wrong', async () => {
    const rig = rigFor(gated);

    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await rig.engine.whenIdle();

    const entry = rig.store.timeline.forRun('run_1').find((e) => e.kind === 'gate_opened');
    expect(entry?.data).toMatchObject({ stepId: 'approve', decisionId: 'dec_1' });
    expect(rig.run('run_1').status).toBe('waiting_gate');
    expect(rig.events.map((e) => e.type)).toContain('decision.opened');
  });
});

describe('a restart during the last allowed agent step', () => {
  const pair = playbook('pair', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')], {
    maxAgentSteps: 2,
  });

  async function interruptSecondStep(): Promise<Rig> {
    const before = rigFor(pair);
    const started = deferred();
    before.executors.codex.script = (_ctx, abort) => {
      started.resolve();
      return untilAborted(abort);
    };
    before.engine.dispatch(signal(), { playbookId: 'pair' });
    await started.promise;
    await before.engine.shutdown();
    return before;
  }

  test('does not count the interrupted attempt twice, so the run still finishes', async () => {
    const before = await interruptSecondStep();
    const after = before.restart();

    after.engine.recover();
    await after.engine.whenIdle();

    const run = after.run('run_1');
    expect(run.status).toBe('succeeded');
    expect(run.stopReason).toBeNull();
    expect(after.executors.codex.calls.map((c) => c.step.id)).toEqual(['fix']);
    expect(after.store.runs.meta('run_1')?.agentStepsStarted).toBe(2);
  });

  test('still counts the attempts that really started: a restart gives back only the interrupted one', async () => {
    const before = await interruptSecondStep();

    expect(before.store.runs.meta('run_1')?.agentStepsStarted).toBe(2);
    const after = before.restart();
    after.engine.setPaused(true);
    after.engine.recover();
    await after.engine.whenIdle();

    expect(after.store.runs.meta('run_1')?.agentStepsStarted).toBe(1);
  });

  test('keeps the allowance honest across repeated restarts of the same step', async () => {
    let rig = await interruptSecondStep();
    for (let boots = 0; boots < 3; boots += 1) {
      rig = rig.restart();
      const started = deferred();
      rig.executors.codex.script = (_ctx, abort) => {
        started.resolve();
        return untilAborted(abort);
      };
      rig.engine.recover();
      await started.promise;
      await rig.engine.shutdown();
    }

    const final = rig.restart();
    final.engine.recover();
    await final.engine.whenIdle();

    expect(final.run('run_1').status).toBe('succeeded');
    expect(final.store.runs.meta('run_1')?.agentStepsStarted).toBe(2);
  });

  test('does not touch the count when the interrupted step was a command', async () => {
    const mixed = playbook('mixed', [agentStep('look', 'inspector'), commandStep('tests', ['npm', 'test'])], {
      maxAgentSteps: 1,
    });
    const before = rigFor(mixed);
    const started = deferred();
    before.commands.script = (_argv, opts) => {
      started.resolve();
      return untilAborted(opts.abort);
    };
    before.engine.dispatch(signal(), { playbookId: 'mixed' });
    await started.promise;
    await before.engine.shutdown();

    const after = before.restart();
    after.engine.recover();
    await after.engine.whenIdle();

    expect(after.run('run_1').status).toBe('succeeded');
    expect(after.store.runs.meta('run_1')?.agentStepsStarted).toBe(1);
  });

  test('a run that really used its allowance still stops', async () => {
    const tight = playbook('tight', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')], {
      maxAgentSteps: 1,
    });
    const rig = rigFor(tight);
    rig.executors.claude.script = () => okResult('Done.');

    rig.engine.dispatch(signal(), { playbookId: 'tight' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('failed');
    expect(rig.run('run_1').stopReason).toContain('allows 1 agent steps');
  });
});
