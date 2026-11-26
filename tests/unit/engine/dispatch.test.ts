import { describe, expect, test } from 'vitest';
import { EngineError } from '../../../src/server/engine/index.js';
import {
  agentStep,
  catalogOf,
  gateStep,
  makeRig,
  MINUTE,
  playbook,
  signal,
  START,
  watch,
} from './support.js';

const gated = playbook('gated', [gateStep('approve')]);
const other = playbook('other', [agentStep('look', 'inspector')]);

describe('dispatch', () => {
  test('stores the signal and announces it', () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });

    const result = rig.engine.dispatch(signal({ url: 'https://example.test/issue/1' }));

    expect(result.signal).toMatchObject({
      id: 'sig_1',
      source: 'manual',
      kind: 'manual.run',
      fingerprint: 'checkout-empty-cart',
      url: 'https://example.test/issue/1',
      receivedAt: START,
    });
    expect(rig.store.signals.get('sig_1')).toEqual(result.signal);
    expect(rig.events[0]).toEqual({ type: 'signal.received', signal: result.signal });
  });

  test('starts nothing when no watch matches', () => {
    const rig = makeRig({
      catalog: catalogOf({ playbooks: [gated], watches: [watch('gh', 'gated', { source: 'github' })] }),
    });

    const result = rig.engine.dispatch(signal());

    expect(result.runs).toEqual([]);
    expect(result.joined).toEqual([]);
    expect(rig.engine.runs({ limit: 10 }).total).toBe(0);
  });

  test('starts one queued run per matching watch, with a signal entry on its timeline', async () => {
    const rig = makeRig({
      catalog: catalogOf({
        playbooks: [gated, other],
        watches: [watch('a', 'gated'), watch('b', 'other'), watch('c', 'gated', { source: 'sentry' })],
      }),
    });

    const result = rig.engine.dispatch(signal());

    expect(result.runs.map((r) => [r.playbookId, r.status])).toEqual([
      ['gated', 'queued'],
      ['other', 'queued'],
    ]);
    expect(result.runs[0]).toMatchObject({
      id: 'run_1',
      signalId: 'sig_1',
      title: 'Checkout page throws on empty cart',
      playbookName: 'Playbook gated',
      playbookVersion: 1,
      duplicateSignals: 0,
      createdAt: START,
    });
    const timeline = rig.engine.runDetail('run_1').timeline;
    expect(timeline[0]).toMatchObject({ kind: 'signal', actor: 'system' });
    expect(timeline[0]?.data).toMatchObject({ signalId: 'sig_1', watchId: 'a', playbookId: 'gated' });
    await rig.engine.whenIdle();
  });

  test('matches on dotted payload paths', async () => {
    const rig = makeRig({
      catalog: catalogOf({
        playbooks: [gated],
        watches: [watch('api-only', 'gated', { match: { 'repository.name': 'api' } })],
      }),
    });

    const hit = rig.engine.dispatch(signal({ payload: { repository: { name: 'api' } } }));
    const miss = rig.engine.dispatch(signal({ payload: { repository: { name: 'web' } } }));

    expect(hit.runs).toHaveLength(1);
    expect(miss.runs).toHaveLength(0);
    await rig.engine.whenIdle();
  });

  test('skips a watch that was disabled from the console, without touching the config', async () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated], watches: [watch('a', 'gated')] }) });

    const updated = rig.engine.setWatchEnabled('a', false);
    const whileOff = rig.engine.dispatch(signal());
    rig.engine.setWatchEnabled('a', true);
    const whileOn = rig.engine.dispatch(signal());

    expect(updated).toMatchObject({ id: 'a', enabled: false });
    expect(whileOff.runs).toHaveLength(0);
    expect(whileOn.runs).toHaveLength(1);
    expect(rig.catalog.watches[0]?.enabled).toBe(true);
    await rig.engine.whenIdle();
  });

  test('refuses to toggle a watch that does not exist', () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });

    expect(() => rig.engine.setWatchEnabled('ghost', false)).toThrowError(EngineError);
  });

  test('starts the named playbook directly, without consulting watches', async () => {
    const rig = makeRig({
      catalog: catalogOf({ playbooks: [gated, other], watches: [watch('a', 'gated')] }),
    });

    const result = rig.engine.dispatch(signal(), { playbookId: 'other' });

    expect(result.runs.map((r) => r.playbookId)).toEqual(['other']);
    expect(rig.engine.runDetail('run_1').timeline[0]?.data).toMatchObject({ watchId: null });
    await rig.engine.whenIdle();
  });

  test('rejects an unknown playbook before storing anything', () => {
    const rig = makeRig({ catalog: catalogOf({ playbooks: [gated] }) });

    const attempt = (): unknown => rig.engine.dispatch(signal(), { playbookId: 'ghost' });

    expect(attempt).toThrowError(/Playbook "ghost" does not exist/);
    expect(rig.store.signals.count()).toBe(0);
  });
});

describe('de-duplication', () => {
  const deduping = catalogOf({
    playbooks: [gated],
    watches: [watch('a', 'gated', { dedupeMinutes: 60 })],
  });

  test('folds a repeat signal into the active run instead of starting another', async () => {
    const rig = makeRig({ catalog: deduping });
    const first = rig.engine.dispatch(signal());
    await rig.engine.whenIdle();

    rig.time.advance(10 * MINUTE);
    const second = rig.engine.dispatch(signal({ title: 'Checkout page throws again' }));

    expect(second.runs).toEqual([]);
    expect(second.joined).toEqual([first.runs[0]?.id]);
    expect(second.signal?.id).toBe('sig_2');
    const detail = rig.engine.runDetail('run_1');
    expect(detail.run.duplicateSignals).toBe(1);
    expect(detail.run.status).toBe('waiting_gate');
    expect(detail.timeline.at(-1)).toMatchObject({ kind: 'system', actor: 'system' });
    expect(detail.timeline.at(-1)?.text).toContain('folded into this run');
    expect(rig.engine.runs({ limit: 10 }).total).toBe(1);
  });

  test('counts every repeat', async () => {
    const rig = makeRig({ catalog: deduping });
    rig.engine.dispatch(signal());
    await rig.engine.whenIdle();

    rig.engine.dispatch(signal());
    rig.engine.dispatch(signal());

    expect(rig.run('run_1').duplicateSignals).toBe(2);
  });

  test('starts a new run for a different fingerprint', async () => {
    const rig = makeRig({ catalog: deduping });
    rig.engine.dispatch(signal());

    const second = rig.engine.dispatch(signal({ fingerprint: 'another-problem' }));

    expect(second.runs).toHaveLength(1);
    expect(second.joined).toEqual([]);
    await rig.engine.whenIdle();
  });

  test('starts a new run once the window has passed', async () => {
    const rig = makeRig({ catalog: deduping });
    rig.engine.dispatch(signal());
    await rig.engine.whenIdle();

    rig.time.advance(61 * MINUTE);
    const second = rig.engine.dispatch(signal());

    expect(second.runs).toHaveLength(1);
    expect(second.joined).toEqual([]);
    await rig.engine.whenIdle();
  });

  test('starts a new run when the earlier one has already ended', async () => {
    const rig = makeRig({ catalog: deduping });
    rig.engine.dispatch(signal());
    await rig.engine.whenIdle();
    rig.engine.cancel('run_1');

    const second = rig.engine.dispatch(signal());

    expect(second.runs).toHaveLength(1);
    expect(second.joined).toEqual([]);
    await rig.engine.whenIdle();
  });

  test('never joins when the watch has no window', async () => {
    const rig = makeRig({
      catalog: catalogOf({ playbooks: [gated], watches: [watch('a', 'gated', { dedupeMinutes: 0 })] }),
    });
    rig.engine.dispatch(signal());

    const second = rig.engine.dispatch(signal());

    expect(second.runs).toHaveLength(1);
    await rig.engine.whenIdle();
  });

  test('does not join a run of a different playbook with the same fingerprint', async () => {
    const rig = makeRig({
      catalog: catalogOf({
        playbooks: [gated, playbook('gated-too', [gateStep('approve')])],
        watches: [watch('a', 'gated', { dedupeMinutes: 60, kinds: ['one'] }), watch('b', 'gated-too', { dedupeMinutes: 60, kinds: ['two'] })],
      }),
    });
    rig.engine.dispatch(signal({ kind: 'one' }));

    const second = rig.engine.dispatch(signal({ kind: 'two' }));

    expect(second.runs.map((r) => r.playbookId)).toEqual(['gated-too']);
    expect(second.joined).toEqual([]);
    await rig.engine.whenIdle();
  });

  test('does not de-duplicate a playbook that was started directly', async () => {
    const rig = makeRig({ catalog: deduping });
    rig.engine.dispatch(signal(), { playbookId: 'gated' });

    const second = rig.engine.dispatch(signal(), { playbookId: 'gated' });

    expect(second.runs).toHaveLength(1);
    await rig.engine.whenIdle();
  });
});
