import { describe, expect, test } from 'vitest';
import type { Run } from '../../../src/shared/types.js';
import type { RunMeta } from '../../../src/server/db/index.js';
import { activeMs, budgetBreach } from '../../../src/server/engine/budget.js';
import {
  agentStep,
  catalogOf,
  commandStep,
  deferred,
  gateStep,
  makeRig,
  MINUTE,
  okResult,
  playbook,
  settle,
  signal,
  START,
  untilAborted,
} from './support.js';

const LONG = { timeoutSeconds: 3600 };

const meta = (extra: Partial<RunMeta> = {}): RunMeta => ({
  fingerprint: 'fp',
  parked: false,
  gateWaitMs: 0,
  agentStepsStarted: 0,
  handoffs: 0,
  ...extra,
});

function runStartedAt(startedAt: string | null): Run {
  return {
    id: 'run_1',
    playbookId: 'p',
    playbookName: 'P',
    playbookVersion: 1,
    signalId: 'sig_1',
    title: 't',
    status: 'running',
    createdAt: START,
    startedAt,
    finishedAt: null,
    currentStepId: null,
    stopReason: null,
    duplicateSignals: 0,
    steps: [],
  };
}

const minutesAfterStart = (minutes: number): Date => new Date(Date.parse(START) + minutes * MINUTE);

describe('budget arithmetic', () => {
  test('counts nothing before the first step starts, and never the time spent at a gate', () => {
    expect(activeMs(runStartedAt(null), meta(), minutesAfterStart(90))).toBe(0);
    expect(activeMs(runStartedAt(START), meta({ gateWaitMs: 20 * MINUTE }), minutesAfterStart(30))).toBe(10 * MINUTE);
    expect(activeMs(runStartedAt(START), meta({ gateWaitMs: 40 * MINUTE }), minutesAfterStart(30))).toBe(0);
  });

  test('stops any step once the minutes are used up, and only agent steps on the counts', () => {
    const budget = { maxMinutes: 15, maxAgentSteps: 1, maxHandoffs: 0 };
    const run = runStartedAt(START);
    const agent = agentStep('next', 'inspector');
    const command = commandStep('tests', ['npm', 'test']);

    expect(budgetBreach(budget, run, meta(), command, minutesAfterStart(14))).toBeNull();
    expect(budgetBreach(budget, run, meta(), command, minutesAfterStart(15))).toContain('working for 15 minutes');
    expect(budgetBreach(budget, run, meta({ agentStepsStarted: 1 }), command, minutesAfterStart(1))).toBeNull();
    expect(budgetBreach(budget, run, meta({ agentStepsStarted: 1 }), agent, minutesAfterStart(1))).toContain('allows 1 agent steps');
    expect(budgetBreach(budget, run, meta(), agentStep('next', 'inspector', { handoffTo: 'fitter' }), minutesAfterStart(1))).toContain(
      'allows 0 handoffs',
    );
    expect(budgetBreach(budget, run, meta(), gateStep('approve'), minutesAfterStart(1))).toBeNull();
  });
});

describe('budget in a run', () => {
  test('counts working time only: a long wait at the gate does not use up the minutes', async () => {
    const timed = playbook(
      'timed',
      [
        agentStep('look', 'inspector', LONG),
        gateStep('approve'),
        agentStep('fix', 'fitter', LONG),
        commandStep('tests', ['npm', 'test']),
      ],
      { maxMinutes: 15 },
    );
    const rig = makeRig({ catalog: catalogOf({ playbooks: [timed] }) });
    rig.executors.claude.script = () => okResult('Looked.');
    rig.executors.codex.script = () => okResult('Fixed.');
    // The minutes pass just after each step finished and before the next one is checked, so
    // only the check before a step can notice (a step that overran would be stopped mid-way).
    const passes: Record<string, number> = { 'Looked.': 10 * MINUTE, 'Fixed.': 6 * MINUTE };
    rig.bus.subscribe((event) => {
      if (event.type === 'timeline.appended' && event.event.kind === 'note') {
        rig.time.advance(passes[event.event.text] ?? 0);
      }
    });

    rig.engine.dispatch(signal(), { playbookId: 'timed' });
    await rig.engine.whenIdle();
    rig.time.advance(60 * MINUTE);
    rig.engine.decide('dec_1', 'approve', null, 'human');
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(rig.executors.codex.calls).toHaveLength(1);
    expect(rig.store.runs.meta('run_1')?.gateWaitMs).toBe(60 * MINUTE);
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe(
      'Stopped before "Run tests": this run has been working for 16 minutes and its playbook allows 15. Time spent waiting for a decision is not counted.',
    );
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'skipped']);
    expect(rig.commands.calls).toHaveLength(0);
    expect(rig.engine.runDetail('run_1').timeline.at(-1)).toMatchObject({ kind: 'error', text: run.stopReason });
  });

  test('stops before an agent step that would go over the agent-step allowance', async () => {
    const busy = playbook(
      'busy',
      [agentStep('first', 'inspector'), commandStep('tests', ['npm', 'test']), agentStep('second', 'fitter'), agentStep('third', 'inspector')],
      { maxAgentSteps: 2 },
    );
    const rig = makeRig({ catalog: catalogOf({ playbooks: [busy] }) });

    rig.engine.dispatch(signal(), { playbookId: 'busy' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('Stopped before "Do third": the playbook allows 2 agent steps and this run has already started 2.');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'skipped']);
    expect(rig.executors.claude.calls.map((c) => c.step.id)).toEqual(['first']);
  });

  test('counts every retry as an agent step, so retrying cannot outrun the allowance', async () => {
    const flaky = playbook('flaky', [agentStep('look', 'inspector', { retries: 3 })], { maxAgentSteps: 2 });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [flaky] }) });
    rig.executors.claude.script = () => {
      throw new Error('session crashed');
    };

    rig.engine.dispatch(signal(), { playbookId: 'flaky' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(rig.executors.claude.calls).toHaveLength(2);
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('Stopped before "Do look": the playbook allows 2 agent steps and this run has already started 2.');
    expect(run.steps[0]).toMatchObject({ status: 'skipped', attempt: 2 });
    const errors = rig.engine.runDetail('run_1').timeline.filter((e) => e.kind === 'error').map((e) => e.text);
    expect(errors).toEqual([
      'Attempt 1 of 4 at "Do look" did not finish: session crashed. Trying again.',
      'Attempt 2 of 4 at "Do look" did not finish: session crashed. Trying again.',
      run.stopReason,
    ]);
  });

  test('stops before a handoff that would go over the handoff allowance', async () => {
    const pingPong = playbook(
      'ping-pong',
      [
        agentStep('a', 'inspector', { handoffTo: 'fitter' }),
        agentStep('b', 'fitter', { handoffTo: 'inspector' }),
        agentStep('c', 'inspector', { handoffTo: 'fitter' }),
      ],
      { maxHandoffs: 2 },
    );
    const rig = makeRig({ catalog: catalogOf({ playbooks: [pingPong] }) });

    rig.engine.dispatch(signal(), { playbookId: 'ping-pong' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(rig.store.runs.meta('run_1')?.handoffs).toBe(2);
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe(
      'Stopped before "Do c": the playbook allows 2 handoffs between operators and this run has already made 2.',
    );
    expect(rig.engine.runDetail('run_1').timeline.filter((e) => e.kind === 'handoff')).toHaveLength(2);
  });

  test('lets a step that hands nothing off run once the handoffs are used up', async () => {
    const enough = playbook(
      'enough',
      [agentStep('a', 'inspector', { handoffTo: 'fitter' }), agentStep('b', 'fitter')],
      { maxHandoffs: 1 },
    );
    const rig = makeRig({ catalog: catalogOf({ playbooks: [enough] }) });

    rig.engine.dispatch(signal(), { playbookId: 'enough' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
  });
});

describe('budget while a step is working', () => {
  const during = (title: string, minutes: string): string =>
    `Stopped during "${title}": this run used up the ${minutes} its playbook allows while the step was still working. Time spent waiting for a decision is not counted.`;

  test('stops an agent step when the minutes run out, not when its own timeout would', async () => {
    const slow = playbook('slow', [agentStep('a', 'inspector', { ...LONG, retries: 2 }), agentStep('b', 'fitter')], {
      maxMinutes: 1,
    });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [slow] }) });
    const started = deferred();
    rig.executors.claude.script = (_ctx, abort) => {
      started.resolve();
      return untilAborted(abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'slow' });
    await started.promise;
    rig.time.advance(MINUTE);
    await settle();
    expect(rig.run('run_1').status).toBe('failed');
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.stopReason).toBe(during('Do a', '1 minute'));
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(run.steps[0]?.summary).toBe(run.stopReason);
    expect(rig.executors.claude.calls).toHaveLength(1);
    expect(rig.executors.codex.calls).toHaveLength(0);
    expect(rig.engine.runDetail('run_1').timeline.at(-1)).toMatchObject({ kind: 'error', text: run.stopReason });
  });

  test('clamps to what is left, not to the whole allowance', async () => {
    const two = playbook('two', [agentStep('a', 'inspector', LONG), agentStep('b', 'fitter', LONG)], { maxMinutes: 2 });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [two] }) });
    rig.executors.claude.script = () => {
      rig.time.advance(90_000);
      return okResult('First done.');
    };
    const started = deferred();
    rig.executors.codex.script = (_ctx, abort) => {
      started.resolve();
      return untilAborted(abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'two' });
    await started.promise;
    rig.time.advance(29_000);
    await new Promise((resolve) => setImmediate(resolve));
    const early = rig.run('run_1').status;
    rig.time.advance(1_000);
    await settle();

    expect(early).toBe('running');
    expect(rig.run('run_1').status).toBe('failed');
    expect(rig.run('run_1').stopReason).toBe(during('Do b', '2 minutes'));
  });

  test('a step with a shorter timeout than what is left still ends with the timeout message', async () => {
    const shortStep = playbook('short', [agentStep('a', 'inspector', { timeoutSeconds: 30, retries: 0 })], { maxMinutes: 10 });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [shortStep] }) });
    const started = deferred();
    rig.executors.claude.script = (_ctx, abort) => {
      started.resolve();
      return untilAborted(abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'short' });
    await started.promise;
    rig.time.advance(30_000);
    await rig.engine.whenIdle();

    expect(rig.run('run_1').stopReason).toContain('timed out after 30 seconds');
  });

  test('stops a command step the same way and tells the runner to stop', async () => {
    const slowCommand = playbook('slow-command', [commandStep('tests', ['npm', 'test'], LONG)], { maxMinutes: 1 });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [slowCommand] }) });
    const started = deferred();
    let stopped = false;
    rig.commands.script = (_argv, opts) => {
      started.resolve();
      opts.abort.addEventListener('abort', () => {
        stopped = true;
      });
      return untilAborted(opts.abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'slow-command' });
    await started.promise;
    rig.time.advance(MINUTE);
    await settle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(stopped).toBe(true);
    expect(run.stopReason).toBe(during('Run tests', '1 minute'));
    expect(run.steps[0]).toMatchObject({ status: 'failed', summary: run.stopReason });
  });

  test('time spent at a gate does not shrink what the next step may use', async () => {
    const gated = playbook('gated-slow', [agentStep('a', 'inspector', LONG), gateStep('g'), agentStep('b', 'fitter', LONG)], {
      maxMinutes: 15,
    });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });
    rig.executors.claude.script = () => {
      rig.time.advance(10 * MINUTE);
      return okResult('Looked.');
    };
    const started = deferred();
    rig.executors.codex.script = (_ctx, abort) => {
      started.resolve();
      return untilAborted(abort);
    };

    rig.engine.dispatch(signal(), { playbookId: 'gated-slow' });
    await rig.engine.whenIdle();
    rig.time.advance(60 * MINUTE);
    rig.engine.decide('dec_1', 'approve', null, 'human');
    await started.promise;
    rig.time.advance(4 * MINUTE);
    await new Promise((resolve) => setImmediate(resolve));
    const early = rig.run('run_1').status;
    rig.time.advance(MINUTE);
    await settle();

    expect(early).toBe('running');
    expect(rig.run('run_1').status).toBe('failed');
    expect(rig.run('run_1').stopReason).toBe(during('Do b', '15 minutes'));
  });

  test('leaves a step alone that finishes inside the minutes', async () => {
    const fine = playbook('fine', [agentStep('a', 'inspector', LONG), commandStep('c', ['npm', 'test'], LONG)], { maxMinutes: 5 });
    const rig = makeRig({ catalog: catalogOf({ playbooks: [fine] }) });
    rig.executors.claude.script = () => {
      rig.time.advance(4 * MINUTE);
      return okResult('Quick enough.');
    };

    rig.engine.dispatch(signal(), { playbookId: 'fine' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
  });
});
