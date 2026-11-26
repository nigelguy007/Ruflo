import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createStore } from '../../../src/server/db/index.js';
import { createEventBus } from '../../../src/server/engine/bus.js';
import {
  canonicalJson,
  createLedger,
  GENESIS_HASH,
  hashEntry,
} from '../../../src/server/engine/ledger.js';
import { silentLogger } from '../../../src/server/logger.js';
import type { StreamEvent } from '../../../src/shared/types.js';
import { FakeTime, sequentialIds, START } from './support.js';

function setup() {
  const store = createStore(':memory:');
  const bus = createEventBus(silentLogger);
  const time = new FakeTime();
  const ledger = createLedger(store, bus, time.clock, sequentialIds());
  return { store, bus, time, ledger };
}

describe('canonicalJson', () => {
  test('serialises object keys in sorted order at every depth', () => {
    const value = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } };

    const text = canonicalJson(value);

    expect(text).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test('gives the same text for the same data whatever the insertion order', () => {
    const first = canonicalJson({ seq: 1, text: 'x', data: { one: 1, two: 2 } });
    const second = canonicalJson({ data: { two: 2, one: 1 }, text: 'x', seq: 1 });

    expect(first).toBe(second);
  });

  test('drops undefined properties the way stored JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 'kept' })).toBe('{"b":"kept"}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('ledger', () => {
  test('starts the chain from 64 zeros and numbers entries from 1', () => {
    const { ledger } = setup();

    const first = ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: 'hello' });

    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(first.at).toBe(START);
    expect(first.mentions).toEqual([]);
    expect(first.data).toBeNull();
  });

  test('hashes prevHash, a newline and the canonical JSON of the entry', () => {
    const { ledger } = setup();

    const entry = ledger.append({
      runId: 'run_1',
      actor: 'inspector',
      kind: 'handoff',
      text: 'over to you',
      mentions: ['fitter'],
      data: { stepId: 'reproduce', nested: { b: 2, a: 1 } },
    });

    const body = canonicalJson({
      seq: entry.seq,
      id: entry.id,
      runId: entry.runId,
      at: entry.at,
      actor: entry.actor,
      kind: entry.kind,
      text: entry.text,
      mentions: entry.mentions,
      data: entry.data,
    });
    const expected = createHash('sha256').update(`${GENESIS_HASH}\n${body}`).digest('hex');
    expect(entry.hash).toBe(expected);
    expect(hashEntry(entry.prevHash, entry)).toBe(entry.hash);
  });

  test('links every entry to the one before it, across runs', () => {
    const { ledger } = setup();

    const a = ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: 'one' });
    const b = ledger.append({ runId: 'run_2', actor: 'system', kind: 'system', text: 'two' });
    const c = ledger.append({ runId: 'run_1', actor: 'human', kind: 'note', text: 'three' });

    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
  });

  test('verifies an untouched chain, including an empty one', () => {
    const { ledger } = setup();

    const empty = ledger.verify();
    for (let i = 0; i < 5; i += 1) {
      ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: `entry ${i}` });
    }
    const full = ledger.verify();

    expect(empty).toEqual({ ok: true, checked: 0, brokenAt: null });
    expect(full).toEqual({ ok: true, checked: 5, brokenAt: null });
  });

  test('still verifies after the data went through storage', () => {
    const { ledger, store } = setup();
    ledger.append({
      runId: 'run_1',
      actor: 'system',
      kind: 'command',
      text: 'ran it',
      data: { when: new Date(0), skipped: undefined, list: [1, undefined], zero: -0 },
    });

    const stored = store.timeline.forRun('run_1')[0];

    expect(stored?.data).toEqual({ when: '1970-01-01T00:00:00.000Z', list: [1, null], zero: 0 });
    expect(ledger.verify().ok).toBe(true);
  });

  test('reports the first entry whose text was edited', () => {
    const { ledger, store } = setup();
    for (let i = 0; i < 4; i += 1) {
      ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: `entry ${i}` });
    }

    store.db.prepare('UPDATE timeline SET text = ? WHERE seq = ?').run('rewritten history', 2);

    expect(ledger.verify()).toEqual({ ok: false, checked: 1, brokenAt: 2 });
  });

  test('reports an entry whose hash was recomputed without fixing the entries after it', () => {
    const { ledger, store } = setup();
    const entries = [0, 1, 2].map((i) =>
      ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: `entry ${i}` }),
    );
    const forged = { ...entries[1]!, text: 'forged' };
    const forgedHash = hashEntry(forged.prevHash, forged);

    store.db
      .prepare('UPDATE timeline SET text = ?, hash = ? WHERE seq = ?')
      .run(forged.text, forgedHash, 2);

    expect(ledger.verify()).toEqual({ ok: false, checked: 2, brokenAt: 3 });
  });

  test('reports a gap when an entry was deleted', () => {
    const { ledger, store } = setup();
    for (let i = 0; i < 3; i += 1) {
      ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: `entry ${i}` });
    }

    store.db.prepare('DELETE FROM timeline WHERE seq = ?').run(2);

    expect(ledger.verify()).toEqual({ ok: false, checked: 1, brokenAt: 3 });
  });

  test('reports a row that can no longer be decoded instead of throwing', () => {
    const { ledger, store } = setup();
    ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: 'fine' });
    ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: 'will be mangled' });

    store.db.prepare('UPDATE timeline SET mentions = ? WHERE seq = ?').run('not json', 2);

    expect(ledger.verify()).toEqual({ ok: false, checked: 1, brokenAt: 2 });
  });

  test('publishes each appended entry', () => {
    const { ledger, bus } = setup();
    const seen: StreamEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const entry = ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: 'hi' });

    expect(seen).toEqual([{ type: 'timeline.appended', event: entry }]);
  });

  test('walks ledgers longer than one page', () => {
    const { ledger } = setup();
    for (let i = 0; i < 1_050; i += 1) {
      ledger.append({ runId: 'run_1', actor: 'system', kind: 'system', text: `entry ${i}` });
    }

    expect(ledger.verify()).toEqual({ ok: true, checked: 1_050, brokenAt: null });
  });
});
