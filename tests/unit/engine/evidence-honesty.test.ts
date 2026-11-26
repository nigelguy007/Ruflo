import { describe, expect, test } from 'vitest';
import type { Evidence, Harness } from '../../../src/shared/types.js';
import { createSimulatedExecutor } from '../../../src/server/executors/simulated.js';
import type { Executor } from '../../../src/server/ports.js';
import {
  agentStep,
  catalogOf,
  commandResult,
  commandStep,
  gateStep,
  makeRig,
  okResult,
  operator,
  playbook,
  signal,
} from './support.js';
import type { Rig } from './support.js';

const CLAIM = { label: 'Fails 5 of 5', detail: 'The new test fails 5 runs out of 5.', ok: true };

function rigWith(harness: Harness, mode: 'live' | 'simulate' = 'live'): Rig {
  const pb = playbook('p', [
    commandStep('tests', ['npm', 'test'], { expectExit: 0 }),
    agentStep('look', 'inspector'),
    gateStep('approve'),
  ]);
  return makeRig({
    catalog: catalogOf({ operators: [operator('inspector', harness), operator('fitter', 'codex')], playbooks: [pb] }),
    config: { mode },
  });
}

/** Runs the playbook up to its gate and returns what was recorded on the way. */
async function evidenceAtGate(rig: Rig): Promise<Evidence[]> {
  rig.engine.dispatch(signal(), { playbookId: 'p' });
  await rig.engine.whenIdle();
  expect(rig.run('run_1').status).toBe('waiting_gate');
  return rig.store.evidence.forRun('run_1');
}

const kinds = (evidence: Evidence[]): string[] => evidence.map((e) => `${e.stepId}:${e.kind}`);

/** Puts a real adapter, or any executor, where the rig has a fake for one harness. */
function install(rig: Rig, harness: Harness, executor: Executor): void {
  (rig.executors as Record<Harness, Executor>)[harness] = executor;
}

describe('what an agent step may be recorded as', () => {
  test('live mode with an operator on the scripted harness records simulated, never claimed', async () => {
    const rig = rigWith('simulated');
    install(rig, 'simulated', createSimulatedExecutor(0));

    const evidence = await evidenceAtGate(rig);

    const fromAgent = evidence.filter((e) => e.stepId === 'look');
    expect(fromAgent.length).toBeGreaterThan(0);
    expect(fromAgent.every((e) => e.kind === 'simulated')).toBe(true);
    expect(evidence.some((e) => e.kind === 'claimed')).toBe(false);
  });

  test('keeps the command evidence the engine observed verified, next to the scripted claims', async () => {
    const rig = rigWith('simulated');
    install(rig, 'simulated', createSimulatedExecutor(0));

    const evidence = await evidenceAtGate(rig);

    expect(evidence[0]).toMatchObject({ stepId: 'tests', kind: 'verified', ok: true });
    expect(evidence.slice(1).every((e) => e.kind === 'simulated')).toBe(true);
  });

  test('shows the person at the gate the same labels', async () => {
    const rig = rigWith('simulated');
    install(rig, 'simulated', createSimulatedExecutor(0));
    await evidenceAtGate(rig);

    const card = rig.engine.runDetail('run_1').decision;

    expect(card?.evidence.map((e) => e.kind)).toContain('verified');
    expect(card?.evidence.map((e) => e.kind)).not.toContain('claimed');
  });

  test('a fake on the simulated harness that never says it is scripted is still recorded as simulated', async () => {
    const rig = rigWith('simulated');
    rig.executors.simulated.script = () => okResult('Done.', { claims: [CLAIM] });

    expect(kinds(await evidenceAtGate(rig))).toEqual(['tests:verified', 'look:simulated']);
  });

  test('live mode with a real harness records what the agent said as claimed', async () => {
    const rig = rigWith('claude');
    rig.executors.claude.script = () => okResult('Done.', { claims: [CLAIM] });

    expect(kinds(await evidenceAtGate(rig))).toEqual(['tests:verified', 'look:claimed']);
  });

  test('an executor that says it is synthetic is recorded as simulated, whatever its harness is called', async () => {
    const rig = rigWith('claude');
    install(rig, 'claude', {
      harness: 'claude',
      synthetic: true,
      run: async () => okResult('Done.', { claims: [CLAIM] }),
    });

    expect(kinds(await evidenceAtGate(rig))).toEqual(['tests:verified', 'look:simulated']);
  });

  test('an executor that says it is not synthetic is believed, even on the simulated harness', async () => {
    const rig = rigWith('simulated');
    install(rig, 'simulated', {
      harness: 'simulated',
      synthetic: false,
      run: async () => okResult('Done.', { claims: [CLAIM] }),
    });

    expect(kinds(await evidenceAtGate(rig))).toEqual(['tests:verified', 'look:claimed']);
  });

  test('simulate mode records simulated whichever harness the operator names', async () => {
    const rig = rigWith('claude', 'simulate');
    rig.executors.simulated.script = () => okResult('Done.', { claims: [CLAIM] });
    rig.commands.script = () => commandResult({ dryRun: true, output: 'dry run' });

    expect(kinds(await evidenceAtGate(rig))).toEqual(['tests:simulated', 'look:simulated']);
  });
});
