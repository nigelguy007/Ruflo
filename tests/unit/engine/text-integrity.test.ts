import { describe, expect, test } from 'vitest';
import { createStore } from '../../../src/server/db/index.js';
import { createEventBus } from '../../../src/server/engine/bus.js';
import { createLedger } from '../../../src/server/engine/ledger.js';
import { silentLogger } from '../../../src/server/logger.js';
import { clip } from '../../../src/server/signals/text.js';
import {
  agentStep,
  catalogOf,
  commandResult,
  commandStep,
  FakeTime,
  gateStep,
  makeRig,
  okResult,
  playbook,
  sequentialIds,
  signal,
} from './support.js';
import type { Rig } from './support.js';

/** What SQLite hands back for a string: lone surrogates become U+FFFD and NUL cuts the text short. */
function survivesStorage(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value && !value.includes('\0');
}

function setup() {
  const store = createStore(':memory:');
  const time = new FakeTime();
  const ledger = createLedger(store, createEventBus(silentLogger), time.clock, sequentialIds());
  const append = (text: string) =>
    ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text });
  return { store, ledger, append };
}

/** Rewrites one row without touching its hash: a genuine tamper. */
function tamper(store: ReturnType<typeof createStore>, seq: number): void {
  store.db.prepare('UPDATE timeline SET text = ? WHERE seq = ?').run('rewritten history', seq);
}

describe('ledger text that SQLite cannot store as given', () => {
  test('a lone surrogate does not make verify report a break, and a later tamper is still found', () => {
    const { ledger, store, append } = setup();
    append('fine');
    append('title: \ud83d');
    append('after it');
    append('and again');

    expect(ledger.verify()).toEqual({ ok: true, checked: 4, brokenAt: null });
    tamper(store, 4);

    expect(ledger.verify()).toEqual({ ok: false, checked: 3, brokenAt: 4 });
  });

  test('a lone low surrogate and a reversed pair are handled the same way', () => {
    const { ledger, append } = setup();
    append('low \ude00 alone');
    append('reversed \ude00\ud83d pair');

    expect(ledger.verify()).toEqual({ ok: true, checked: 2, brokenAt: null });
  });

  test('NUL does not cut the text short or break verify, and a later tamper is still found', () => {
    const { ledger, store, append } = setup();
    append('before\0after');
    append('next');
    append('last');

    expect(ledger.verify()).toEqual({ ok: true, checked: 3, brokenAt: null });
    tamper(store, 3);

    expect(ledger.verify()).toEqual({ ok: false, checked: 2, brokenAt: 3 });
  });

  test('returns exactly the text it stored, so what was hashed is what is on disk', () => {
    const { store, append } = setup();

    const entry = append('lone \ud83d and nul \0 here');

    expect(survivesStorage(entry.text)).toBe(true);
    expect(entry.text).toBe('lone � and nul � here');
    expect(store.timeline.forRun('run_1')[0]?.text).toBe(entry.text);
  });

  test('the length cap never leaves half an emoji behind', () => {
    const { ledger, store, append } = setup();

    const entry = append(`${'x'.repeat(7_999)}😀 trailing`);

    expect(entry.text).toBe(`${'x'.repeat(7_999)}😀`);
    expect(store.timeline.forRun('run_1')[0]?.text).toBe(entry.text);
    expect(ledger.verify().ok).toBe(true);
  });

  test('keeps intact text, emoji included, exactly as given', () => {
    const { append } = setup();

    expect(append('Checkout fails 😀 für Kunden – 日本語').text).toBe('Checkout fails 😀 für Kunden – 日本語');
  });

  test('strings in the actor and run id are made storable too', () => {
    const { ledger, store } = setup();

    const entry = ledger.append({ runId: 'run\ud83d', actor: 'op\0erator', kind: 'note', text: 'x' });

    expect(survivesStorage(entry.runId)).toBe(true);
    expect(survivesStorage(entry.actor)).toBe(true);
    expect(store.timeline.forRun(entry.runId)[0]).toMatchObject({ runId: entry.runId, actor: entry.actor });
    expect(ledger.verify().ok).toBe(true);
  });
});

const oneAgent = playbook('one', [agentStep('look', 'inspector'), agentStep('fix', 'fitter')]);

function rigFor(...playbooks: ReturnType<typeof playbook>[]): Rig {
  return makeRig({ catalog: catalogOf({ playbooks }) });
}

describe('text that comes in through the engine', () => {
  test('a manual signal title that is a lone surrogate leaves the ledger verifiable', async () => {
    const rig = rigFor(oneAgent);

    rig.engine.dispatch(signal({ title: 'Checkout fails \ud83d' }), { playbookId: 'one' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
    const total = rig.store.timeline.count();
    expect(rig.engine.verifyLedger()).toEqual({ ok: true, checked: total, brokenAt: null });
    rig.store.db.prepare('UPDATE timeline SET text = ? WHERE seq = ?').run('rewritten', total);
    expect(rig.engine.verifyLedger()).toEqual({ ok: false, checked: total - 1, brokenAt: total });
  });

  test('a long webhook title cut by the signal adapters in the middle of an emoji keeps the ledger verifiable', async () => {
    const rig = rigFor(oneAgent);
    const title = clip(`${'x'.repeat(198)}😀 more words that push the title over the limit`);

    rig.engine.dispatch(signal({ title }), { playbookId: 'one' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').status).toBe('succeeded');
    expect(rig.engine.verifyLedger()).toEqual({ ok: true, checked: rig.store.timeline.count(), brokenAt: null });
  });

  test('the title is stored once, the same way, in the signal, the run and the ledger', async () => {
    const rig = rigFor(oneAgent);

    rig.engine.dispatch(signal({ title: 'Checkout fails \ud83d\0!' }), { playbookId: 'one' });
    await rig.engine.whenIdle();

    const detail = rig.engine.runDetail('run_1');
    const title = 'Checkout fails ��!';
    expect(detail.signal.title).toBe(title);
    expect(detail.run.title).toBe(title);
    expect(detail.timeline[0]?.text).toContain(title);
    expect(rig.store.runs.get('run_1')?.steps.every((s) => survivesStorage(s.title))).toBe(true);
  });

  test('a signal title with a NUL in it does not shorten the title the console shows', async () => {
    const rig = rigFor(oneAgent);

    rig.engine.dispatch(signal({ title: 'Cart total is\0NaN' }), { playbookId: 'one' });
    await rig.engine.whenIdle();

    expect(rig.engine.runDetail('run_1').signal.title).toBe('Cart total is�NaN');
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });

  test('an agent summary cut at the length limit mid-emoji stays whole and verifiable', async () => {
    const rig = rigFor(oneAgent);
    rig.executors.claude.script = () => okResult(`${'x'.repeat(3_999)}😀 trailing text`);

    rig.engine.dispatch(signal(), { playbookId: 'one' });
    await rig.engine.whenIdle();

    const summary = rig.run('run_1').steps[0]?.summary ?? '';
    expect(summary).toBe(`${'x'.repeat(3_999)}😀`);
    expect(survivesStorage(summary)).toBe(true);
    expect(rig.engine.verifyLedger()).toEqual({
      ok: true,
      checked: rig.store.timeline.count(),
      brokenAt: null,
    });
  });

  test('an agent summary that arrives with a lone surrogate is stored well-formed', async () => {
    const rig = rigFor(oneAgent);
    rig.executors.claude.script = () => okResult('Looked at \ud83d the cart.');

    rig.engine.dispatch(signal(), { playbookId: 'one' });
    await rig.engine.whenIdle();

    expect(rig.run('run_1').steps[0]?.summary).toBe('Looked at � the cart.');
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });

  test('artifact and claim text is clipped by character, not by half an emoji', async () => {
    const rig = rigFor(oneAgent);
    rig.executors.claude.script = () =>
      okResult('ok', {
        artifacts: [{ kind: 'log', label: `${'l'.repeat(199)}😀tail`, value: 'v' }],
        claims: [{ label: `${'c'.repeat(199)}😀tail`, detail: 'd\0e', ok: true }],
      });

    rig.engine.dispatch(signal(), { playbookId: 'one' });
    await rig.engine.whenIdle();

    const evidence = rig.store.evidence.forRun('run_1')[0];
    expect(evidence?.label).toBe(`${'c'.repeat(199)}😀`);
    expect(evidence?.detail).toBe('d�e');
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });

  test('a failure reason cut at the length limit mid-emoji keeps the ledger verifiable', async () => {
    const rig = rigFor(oneAgent);
    rig.executors.claude.script = () => {
      throw new Error(`${'e'.repeat(499)}😀 and more`);
    };

    rig.engine.dispatch(signal(), { playbookId: 'one' });
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    expect(run.status).toBe('failed');
    expect(survivesStorage(run.stopReason ?? '')).toBe(true);
    expect(survivesStorage(run.steps[0]?.summary ?? '')).toBe(true);
    expect(rig.engine.verifyLedger()).toEqual({
      ok: true,
      checked: rig.store.timeline.count(),
      brokenAt: null,
    });
  });

  test('command output cut at the tail limit mid-emoji and containing NUL is stored well-formed', async () => {
    const rig = rigFor(playbook('cmd', [commandStep('c', ['npm', 'test'], { expectExit: 0 })]));
    // 2 000 characters of tail are kept; the cut lands inside the emoji at the front.
    rig.commands.script = () => commandResult({ output: `${'😀'.repeat(1_500)}\0binary` });

    rig.engine.dispatch(signal(), { playbookId: 'cmd' });
    await rig.engine.whenIdle();

    const detail = rig.store.evidence.forRun('run_1')[0]?.detail ?? '';
    expect(survivesStorage(detail)).toBe(true);
    expect(detail).toContain('binary');
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });

  test('a decision note with a lone surrogate or NUL is the same in the decision and the ledger', async () => {
    const rig = rigFor(playbook('gated', [gateStep('approve'), agentStep('fix', 'fitter')]));
    rig.engine.dispatch(signal(), { playbookId: 'gated' });
    await rig.engine.whenIdle();

    const decision = rig.engine.decide('dec_1', 'approve', 'looks fine \ud83d\0 ok', 'dana\ud83d');
    await rig.engine.whenIdle();

    expect(decision.note).toBe('looks fine �� ok');
    expect(decision.decidedBy).toBe('dana�');
    const resolved = rig.store.timeline.forRun('run_1').find((e) => e.kind === 'gate_resolved');
    expect(resolved?.text).toBe('Approved by dana�: looks fine �� ok');
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });

  test('a gate question and the stop reason built from it are stored the way the ledger shows them', async () => {
    const asking = { ...gateStep('approve'), question: 'Ship \ud83d it?' };
    const rig = rigFor(playbook('quest', [asking]));
    rig.engine.dispatch(signal(), { playbookId: 'quest' });
    await rig.engine.whenIdle();
    rig.engine.decide('dec_1', 'reject', 'no \ud83d', 'dana');
    await rig.engine.whenIdle();

    const run = rig.run('run_1');
    const opened = rig.store.timeline.forRun('run_1').find((e) => e.kind === 'gate_opened');
    expect(rig.store.decisions.get('dec_1')?.question).toBe('Ship � it?');
    expect(opened?.text).toBe('Waiting for a decision: Ship � it?');
    expect(run.status).toBe('rejected');
    expect(run.stopReason).toBe('A person answered no to "Ship � it?": no �');
    expect(rig.engine.verifyLedger().ok).toBe(true);
  });
});
