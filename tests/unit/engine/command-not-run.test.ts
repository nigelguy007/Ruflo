import { describe, expect, test } from 'vitest';
import {
  agentStep,
  catalogOf,
  commandResult,
  commandStep,
  makeRig,
  playbook,
  signal,
} from './support.js';
import type { Rig } from './support.js';

const REFUSED = 'refused: "rm" is not in SWITCHYARD_ALLOWED_COMMANDS (npm). Nothing was executed.';
const NOT_STARTED = 'could not start "npm": spawn npm ENOENT';

function rigFor(expectExit?: number): Rig {
  const step = commandStep('tests', ['npm', 'test'], expectExit === undefined ? {} : { expectExit });
  const pb = playbook('p', [step, agentStep('ship', 'inspector')]);
  return makeRig({ catalog: catalogOf({ playbooks: [pb] }) });
}

async function runWith(rig: Rig, result: Partial<ReturnType<typeof commandResult>>): Promise<void> {
  rig.commands.script = () => commandResult(result);
  rig.engine.dispatch(signal(), { playbookId: 'p' });
  await rig.engine.whenIdle();
}

describe('a command the runner did not execute', () => {
  test('fails the step and the run even when the playbook sets no expected exit code', async () => {
    const rig = rigFor();

    await runWith(rig, { exitCode: 126, output: REFUSED, executed: false });

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(rig.executors.claude.calls).toHaveLength(0);
  });

  test('is never recorded as verified, and says in its label that it was not run', async () => {
    const rig = rigFor();

    await runWith(rig, { exitCode: 126, output: REFUSED, executed: false });

    const evidence = rig.store.evidence.forRun('run_1');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).not.toBe('verified');
    expect(evidence[0]).toMatchObject({ stepId: 'tests', label: 'Run tests (not run)', ok: false });
    expect(evidence[0]?.detail).toContain('$ npm test');
    expect(evidence[0]?.detail).toContain('not run');
    expect(evidence[0]?.detail).toContain(REFUSED);
  });

  test('names the command and the reason in the stop reason', async () => {
    const rig = rigFor();

    await runWith(rig, { exitCode: 126, output: REFUSED, executed: false });

    expect(rig.run('run_1').stopReason).toBe(`\`npm test\` could not be run: ${REFUSED.replace(/\.$/, '')}.`);
  });

  test('stays a failure when the playbook expects the very exit code the runner invented', async () => {
    const rig = rigFor(127);

    await runWith(rig, { exitCode: 127, output: NOT_STARTED, executed: false });

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe(`\`npm test\` could not be run: ${NOT_STARTED}.`);
    expect(rig.store.evidence.forRun('run_1')[0]).toMatchObject({ ok: false });
    expect(rig.store.evidence.forRun('run_1')[0]?.kind).not.toBe('verified');
  });

  test('is written on the timeline as not run, with the fact in the entry data', async () => {
    const rig = rigFor();

    await runWith(rig, { exitCode: 126, output: REFUSED, executed: false });

    const entry = rig.engine.runDetail('run_1').timeline.find((e) => e.kind === 'command');
    expect(entry?.text).toBe(`Did not run \`npm test\`: ${REFUSED.replace(/\.$/, '')}.`);
    expect(entry?.data).toMatchObject({ stepId: 'tests', exitCode: 126, executed: false });
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });

  test('fails even when the exit code it reports is the one the playbook expects', async () => {
    const rig = rigFor(0);

    await runWith(rig, { exitCode: 0, output: 'ok', executed: false });

    expect(rig.run('run_1').status).toBe('failed');
    expect(rig.store.evidence.forRun('run_1')[0]).toMatchObject({ ok: false });
  });
});

describe('a command that did run, or a dry run', () => {
  test('is verified as before when the runner says nothing about executed', async () => {
    const rig = rigFor();

    await runWith(rig, { exitCode: 1, output: '3 advisories' });

    expect(rig.run('run_1').status).toBe('succeeded');
    expect(rig.store.evidence.forRun('run_1')[0]).toMatchObject({ kind: 'verified', ok: null, label: 'Run tests' });
  });

  test('is verified when the runner says executed is true', async () => {
    const rig = rigFor(0);

    await runWith(rig, { exitCode: 0, executed: true });

    expect(rig.store.evidence.forRun('run_1')[0]).toMatchObject({ kind: 'verified', ok: true });
  });

  test('a dry run keeps its meaning: simulated, nothing executed, the step passes', async () => {
    const rig = rigFor(0);

    await runWith(rig, { dryRun: true, output: 'dry run: would execute npm test' });

    expect(rig.run('run_1').status).toBe('succeeded');
    expect(rig.store.evidence.forRun('run_1')[0]).toMatchObject({
      kind: 'simulated',
      ok: true,
      label: 'Run tests',
    });
  });
});
