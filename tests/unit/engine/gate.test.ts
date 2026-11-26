import { describe, expect, test } from 'vitest';
import { EngineError } from '../../../src/server/engine/index.js';
import {
  agentStep,
  catalogOf,
  commandStep,
  gateStep,
  makeRig,
  MINUTE,
  okResult,
  playbook,
  signal,
} from './support.js';
import type { Rig } from './support.js';

const stopping = playbook('stopping', [
  agentStep('fix', 'fitter'),
  commandStep('tests', ['npm', 'test'], { expectExit: 0 }),
  gateStep('approve', 'stop'),
  commandStep('merge', ['npm', 'publish']),
  agentStep('watch', 'inspector'),
]);
const continuing = playbook('continuing', [
  gateStep('notify', 'continue'),
  agentStep('wrap-up', 'inspector'),
]);

async function reachGate(rig: Rig, playbookId: string): Promise<void> {
  rig.engine.dispatch(signal(), { playbookId });
  await rig.engine.whenIdle();
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

describe('gate step', () => {
  test('opens a decision carrying the evidence gathered so far and parks the run', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });
    rig.executors.codex.script = () =>
      okResult('Fixed.', { claims: [{ label: 'Regression test added', detail: 'cart.test.ts', ok: true }] });

    await reachGate(rig, 'stopping');

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.status).toBe('waiting_gate');
    expect(detail.run.currentStepId).toBe('approve');
    expect(detail.run.steps.map((s) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'waiting',
      'pending',
      'pending',
    ]);
    expect(detail.decision).toMatchObject({
      id: 'dec_1',
      runId: 'run_1',
      runTitle: 'Checkout page throws on empty cart',
      stepId: 'approve',
      question: 'Go ahead with approve?',
      status: 'open',
      decidedAt: null,
      decidedBy: null,
      note: null,
    });
    expect(detail.decision?.evidence.map((e) => [e.kind, e.label, e.ok])).toEqual([
      ['claimed', 'Regression test added', true],
      ['verified', 'Run tests', true],
    ]);
    expect(detail.timeline.at(-1)).toMatchObject({ kind: 'gate_opened', actor: 'system' });
    expect(rig.commands.calls).toHaveLength(1);
  });

  test('announces the decision', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });

    await reachGate(rig, 'stopping');

    const opened = rig.events.filter((e) => e.type === 'decision.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ decision: { id: 'dec_1', status: 'open' } });
    expect(rig.engine.decisions({ status: 'open', limit: 10 })).toMatchObject({ total: 1 });
  });

  test('resumes the run when the decision is approved', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });
    await reachGate(rig, 'stopping');
    rig.time.advance(5 * MINUTE);

    const decision = rig.engine.decide('dec_1', 'approve', '  ship it  ', 'human');
    await rig.engine.whenIdle();

    expect(decision).toMatchObject({ status: 'approved', decidedBy: 'human', note: 'ship it' });
    expect(decision.decidedAt).toBe('2026-11-26T12:05:00.000Z');
    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.status).toBe('succeeded');
    expect(detail.run.steps.map((s) => s.status)).toEqual(Array(5).fill('succeeded'));
    expect(detail.run.steps[2]?.summary).toBe('Approved by human: ship it');
    expect(detail.timeline.find((e) => e.kind === 'gate_resolved')).toMatchObject({
      actor: 'human',
      text: 'Approved by human: ship it',
      data: { decisionId: 'dec_1', verdict: 'approve' },
    });
    expect(rig.commands.calls.map((c) => c.argv.join(' '))).toEqual(['npm test', 'npm publish']);
    expect(rig.events.filter((e) => e.type === 'decision.resolved')).toHaveLength(1);
  });

  test('ends the run as rejected and skips what is left when the gate says stop', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });
    await reachGate(rig, 'stopping');

    const decision = rig.engine.decide('dec_1', 'reject', 'not on a Friday', 'human');
    await rig.engine.whenIdle();

    expect(decision.status).toBe('rejected');
    const run = rig.run('run_1');
    expect(run.status).toBe('rejected');
    expect(run.stopReason).toBe('A person answered no to "Go ahead with approve?": not on a Friday');
    expect(run.steps.map((s) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'failed',
      'skipped',
      'skipped',
    ]);
    expect(run.finishedAt).not.toBeNull();
    expect(rig.commands.calls).toHaveLength(1);
    expect(rig.executors.claude.calls).toHaveLength(0);
  });

  test('carries on after a rejection when the gate says continue', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [continuing] }) });
    await reachGate(rig, 'continuing');

    rig.engine.decide('dec_1', 'reject', undefined, 'human');
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(run.steps[0]?.summary).toBe('Answered no by human; the playbook carries on.');
    expect(rig.executors.claude.calls.map((c) => c.step.id)).toEqual(['wrap-up']);
    expect(rig.engine.decisions({ limit: 10 }).items[0]).toMatchObject({ status: 'rejected', note: null });
  });

  test('refuses a second answer', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });
    await reachGate(rig, 'stopping');
    rig.engine.decide('dec_1', 'approve', null, 'human');

    const error = caught(() => rig.engine.decide('dec_1', 'reject', null, 'human'));
    await rig.engine.whenIdle();

    expect(error.code).toBe('conflict');
    expect(error.message).toContain('already been answered (approved)');
    expect(rig.run('run_1').status).toBe('succeeded');
  });

  test('reports an unknown decision as not found', () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });

    expect(caught(() => rig.engine.decide('dec_404', 'approve', null, 'human')).code).toBe('not_found');
  });

  test('resumes even when the answer arrives in the same breath as the question', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [stopping] }) });
    rig.bus.subscribe((event) => {
      if (event.type === 'decision.opened') rig.engine.decide(event.decision.id, 'approve', null, 'human');
    });

    await reachGate(rig, 'stopping');

    expect(rig.run('run_1').status).toBe('succeeded');
  });

  test('handles two gates in one run', async () => {
    const twice = playbook('twice', [gateStep('first'), agentStep('work', 'inspector'), gateStep('second')]);
    const rig = makeRig({ catalog: catalogOf({ playbooks: [twice] }) });
    await reachGate(rig, 'twice');

    rig.engine.decide('dec_1', 'approve', null, 'human');
    await rig.engine.whenIdle();
    const between = rig.engine.runDetail('run_1');
    rig.engine.decide('dec_2', 'approve', null, 'human');
    await rig.engine.whenIdle();

    expect(between.run.status).toBe('waiting_gate');
    expect(between.decision).toMatchObject({ id: 'dec_2', stepId: 'second', status: 'open' });
    expect(rig.run('run_1').status).toBe('succeeded');
  });
});
