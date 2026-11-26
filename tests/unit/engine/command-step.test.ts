import { describe, expect, test } from 'vitest';
import { displayCommand } from '../../../src/server/engine/steps/command.js';
import {
  agentStep,
  catalogOf,
  commandResult,
  commandStep,
  deferred,
  makeRig,
  playbook,
  signal,
} from './support.js';

const checked = playbook('checked', [
  commandStep('tests', ['npm', 'test'], { expectExit: 0, timeoutSeconds: 90 }),
  agentStep('review', 'inspector'),
]);
const unchecked = playbook('unchecked', [commandStep('audit', ['npm', 'audit', '--omit=dev'])]);

describe('command step', () => {
  test('runs the argv in the configured checkout with the step timeout', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [checked] }) });

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const call = rig.commands.calls[0];
    expect(call?.argv).toEqual(['npm', 'test']);
    expect(call?.opts.cwd).toBe('/srv/checkout');
    expect(call?.opts.timeoutMs).toBe(90_000);
    expect(call?.opts.abort).toBeInstanceOf(AbortSignal);
    expect(rig.run('run_1').status).toBe('succeeded');
  });

  test('records what it saw as verified evidence that supports going ahead', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [checked] }) });
    rig.commands.script = () => commandResult({ output: 'Tests  12 passed (12)\n' });

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.evidence).toEqual([
      {
        id: 'evd_1',
        runId: 'run_1',
        stepId: 'tests',
        kind: 'verified',
        label: 'Run tests',
        detail: '$ npm test\nexit code 0 (expected 0)\nTests  12 passed (12)',
        ok: true,
      },
    ]);
    const entry = detail.timeline.find((e) => e.kind === 'command');
    expect(entry).toMatchObject({ actor: 'system', text: 'Ran `npm test`: exit code 0 (expected 0).' });
    expect(entry?.data).toEqual({
      stepId: 'tests',
      argv: ['npm', 'test'],
      exitCode: 0,
      dryRun: false,
      timedOut: false,
    });
    expect(detail.run.steps[0]?.summary).toBe('Ran `npm test`: exit code 0 (expected 0).');
  });

  test('leaves the verdict open when the playbook expects no particular exit code', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [unchecked] }) });
    rig.commands.script = () => commandResult({ exitCode: 1, output: '3 moderate advisories' });

    rig.engine.dispatch(signal(), { playbookId: 'unchecked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.status).toBe('succeeded');
    expect(detail.evidence[0]).toMatchObject({
      kind: 'verified',
      ok: null,
      detail: '$ npm audit --omit=dev\nexit code 1\n3 moderate advisories',
    });
  });

  test('gives a step 600 seconds when it sets no timeout', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [unchecked] }) });

    rig.engine.dispatch(signal(), { playbookId: 'unchecked' });
    await rig.engine.whenIdle();

    expect(rig.commands.calls[0]?.opts.timeoutMs).toBe(600_000);
  });

  test('marks a dry run as simulated evidence', async () => {
    const rig = makeRig({
      catalog: catalogOf({ playbooks: [checked] }),
      config: { mode: 'simulate', workdir: null },
    });
    rig.commands.script = (argv) =>
      commandResult({ dryRun: true, output: `dry run: would execute ${argv.join(' ')}` });

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.evidence[0]).toMatchObject({ kind: 'simulated', ok: true });
    expect(detail.timeline.find((e) => e.kind === 'command')?.text).toBe(
      'Dry run of `npm test`: nothing was executed.',
    );
    expect(rig.commands.calls[0]?.opts.cwd).toBeNull();
  });

  test('fails the step and the run when the exit code is not the expected one', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [checked] }) });
    rig.commands.script = () => commandResult({ exitCode: 1, output: '2 failed' });

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.status).toBe('failed');
    expect(detail.run.stopReason).toBe('`npm test` exited with code 1; the playbook expects 0.');
    expect(detail.run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(detail.evidence[0]).toMatchObject({ kind: 'verified', ok: false });
    expect(rig.executors.claude.calls).toHaveLength(0);
  });

  test('keeps only the tail of long output', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [checked] }) });
    rig.commands.script = () => commandResult({ output: `${'x'.repeat(10_000)}THE END` });

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1').evidence[0]?.detail ?? '';
    const output = detail.split('\n').slice(2).join('\n');
    expect(output).toHaveLength(2_000);
    expect(output.startsWith('…')).toBe(true);
    expect(output.endsWith('THE END')).toBe(true);
  });

  test('fails when the runner reports a timeout, whatever the exit code', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [unchecked] }) });
    rig.commands.script = () => commandResult({ exitCode: 0, timedOut: true, output: 'still going' });

    rig.engine.dispatch(signal(), { playbookId: 'unchecked' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.status).toBe('failed');
    expect(detail.run.stopReason).toBe('`npm audit --omit=dev` did not finish within 600 seconds.');
    expect(detail.evidence[0]).toMatchObject({ ok: false });
    expect(detail.evidence[0]?.detail).toContain('timed out after 600 seconds');
  });

  test('fails with the reason when the command cannot be run at all', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [checked] }) });
    rig.commands.script = () => {
      throw new Error('"npm" is not on the list of allowed commands.');
    };

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(run.stopReason).toBe('`npm test` could not be run: "npm" is not on the list of allowed commands.');
    expect(run.steps[0]?.status).toBe('failed');
    expect(rig.engine.runDetail('run_1').evidence).toEqual([]);
  });

  test('gives up on a runner that never comes back, shortly after its timeout', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [checked] }) });
    const started = deferred();
    rig.commands.script = () => {
      started.resolve();
      return new Promise(() => undefined);
    };

    rig.engine.dispatch(signal(), { playbookId: 'checked' });
    await started.promise;
    rig.time.advance(90_000);
    const atTimeout = rig.run('run_1').status;
    rig.time.advance(5_000);
    await rig.engine.whenIdle();

    expect(atTimeout).toBe('running');
    expect(rig.run('run_1').stopReason).toBe('`npm test` did not finish within 90 seconds.');
  });
});

describe('displayCommand', () => {
  test('quotes arguments that contain spaces or quotes', () => {
    expect(displayCommand(['git', 'commit', '-m', 'fix the cart'])).toBe('git commit -m "fix the cart"');
    expect(displayCommand(['echo', 'it\'s'])).toBe('echo "it\'s"');
    expect(displayCommand(['npm', 'test'])).toBe('npm test');
  });
});
