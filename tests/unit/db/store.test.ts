import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { migrate, schemaVersion } from '../../../src/server/db/database.js';
import { createStore } from '../../../src/server/db/index.js';
import type { Store } from '../../../src/server/db/index.js';
import { MIGRATIONS } from '../../../src/server/db/schema.js';
import { START } from '../engine/support.js';
import { at, evidence, newRun, openDecision, storedSignal, storeWithSignals, timelineEvent } from './fixtures.js';

let store: Store | null = null;
const temporary: string[] = [];

afterEach(() => {
  store?.close();
  store = null;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(...runIds: string[]): Store {
  store = storeWithSignals(...runIds);
  for (const id of runIds) store.runs.insert(newRun(id));
  return store;
}

describe('database', () => {
  test('creates the directory of a file database and brings the schema up to date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-db-'));
    temporary.push(dir);
    const path = join(dir, 'nested', 'switchyard.db');

    store = createStore(path);

    expect(existsSync(path)).toBe(true);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    expect(store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  test('keeps what was written when the same file is opened again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-db-'));
    temporary.push(dir);
    const path = join(dir, 'switchyard.db');
    const first = createStore(path);
    first.signals.insert(storedSignal('sig-1'));
    first.close();

    store = createStore(path);

    expect(store.signals.get('sig-1')?.title).toBe('Signal sig-1');
  });

  test('applies only the migrations a database has not seen', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, ['CREATE TABLE one (x INTEGER)']);
    migrate(db, ['CREATE TABLE one (x INTEGER)', 'CREATE TABLE two (y INTEGER)']);

    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 2 });
    db.close();
  });

  test('rolls a failing migration back and leaves the version where it was', () => {
    const db = new DatabaseSync(':memory:');

    expect(() => migrate(db, ['CREATE TABLE one (x INTEGER)', 'CREATE TABLE two (y INTEGER); NOT SQL'])).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'two'").get()).toBeUndefined();
    db.close();
  });

  test('refuses a database written by a newer build', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);

    expect(() => migrate(db)).toThrow('is newer than this build understands');
    db.close();
  });

  test('commits a transaction, rolls it back on error, and lets inner calls join the outer one', () => {
    const s = open();
    s.transaction(() => s.signals.insert(storedSignal('kept')));
    const failing = (): void => {
      s.transaction(() => {
        s.signals.insert(storedSignal('outer'));
        s.transaction(() => s.signals.insert(storedSignal('inner')));
        throw new Error('changed my mind');
      });
    };

    expect(failing).toThrow('changed my mind');
    expect(s.signals.list(10).map((x) => x.id)).toEqual(['kept']);
    expect(s.transaction(() => 42)).toBe(42);
  });

  test('can be closed twice', () => {
    const s = createStore(':memory:');
    s.close();

    expect(() => s.close()).not.toThrow();
  });
});

describe('signal repository', () => {
  test('round-trips a signal, payload included', () => {
    const s = open();
    const signal = storedSignal('sig-1', { url: 'https://example.com/1', payload: { nested: { n: 1 }, list: [1, 'two'] } });

    s.signals.insert(signal);

    expect(s.signals.get('sig-1')).toEqual(signal);
    expect(s.signals.get('missing')).toBeNull();
  });

  test('lists newest first, counts, and knows when the last one arrived', () => {
    const s = open();
    expect(s.signals.lastReceivedAt()).toBeNull();
    s.signals.insert(storedSignal('one', { receivedAt: at(1) }));
    s.signals.insert(storedSignal('two', { receivedAt: at(2) }));
    s.signals.insert(storedSignal('three', { receivedAt: at(3) }));

    expect(s.signals.list(2).map((x) => x.id)).toEqual(['three', 'two']);
    expect(s.signals.count()).toBe(3);
    expect(s.signals.lastReceivedAt()).toBe(at(3));
  });
});

describe('evidence repository', () => {
  test('keeps evidence in the order it was gathered, with its verdict', () => {
    const s = open('a', 'b');
    s.evidence.insert(evidence('e1', 'a', true));
    s.evidence.insert(evidence('e2', 'b', false));
    s.evidence.insert(evidence('e3', 'a', null));
    s.evidence.insert(evidence('e4', 'a', false));

    expect(s.evidence.forRun('a').map((e) => [e.id, e.ok])).toEqual([
      ['e1', true],
      ['e3', null],
      ['e4', false],
    ]);
    expect(s.evidence.forRun('a')[0]).toEqual(evidence('e1', 'a', true));
    expect(s.evidence.forRun('nobody')).toEqual([]);
  });
});

describe('decision repository', () => {
  test('round-trips a decision with the evidence it carries', () => {
    const s = open('a');
    const decision = openDecision('d1', 'a', { evidence: [evidence('e1', 'a'), evidence('e2', 'a', null)] });

    s.decisions.insert(decision);

    expect(s.decisions.get('d1')).toEqual(decision);
    expect(s.decisions.get('missing')).toBeNull();
  });

  test('lists newest first, by status, and counts the same way', () => {
    const s = open('a', 'b');
    s.decisions.insert(openDecision('d1', 'a', { status: 'approved' }));
    s.decisions.insert(openDecision('d2', 'b'));
    s.decisions.insert(openDecision('d3', 'a'));

    expect(s.decisions.list({ limit: 10 }).map((d) => d.id)).toEqual(['d3', 'd2', 'd1']);
    expect(s.decisions.list({ status: 'open', limit: 1 }).map((d) => d.id)).toEqual(['d3']);
    expect(s.decisions.count()).toBe(3);
    expect(s.decisions.count('open')).toBe(2);
    expect(s.decisions.count('rejected')).toBe(0);
  });

  test('finds the open and the latest decision of a run', () => {
    const s = open('a', 'b');
    s.decisions.insert(openDecision('d1', 'a', { status: 'approved' }));
    s.decisions.insert(openDecision('d2', 'a'));
    s.decisions.insert(openDecision('d3', 'b', { status: 'rejected' }));

    expect(s.decisions.openForRun('a')?.id).toBe('d2');
    expect(s.decisions.openForRun('b')).toBeNull();
    expect(s.decisions.latestForRun('b')?.id).toBe('d3');
    expect(s.decisions.latestForRun('nobody')).toBeNull();
  });

  test('resolves a decision exactly once', () => {
    const s = open('a');
    s.decisions.insert(openDecision('d1', 'a'));
    const resolution = { status: 'approved' as const, decidedAt: at(5), decidedBy: 'human', note: 'fine' };

    const first = s.decisions.resolve('d1', resolution);
    const second = s.decisions.resolve('d1', { ...resolution, status: 'rejected' });

    expect(first).toMatchObject({ status: 'approved', decidedAt: at(5), decidedBy: 'human', note: 'fine' });
    expect(second).toBeNull();
    expect(s.decisions.get('d1')?.status).toBe('approved');
    expect(s.decisions.resolve('missing', resolution)).toBeNull();
  });

  test('counts the decisions people made since a moment, leaving out the system', () => {
    const s = open('a');
    s.decisions.insert(openDecision('d1', 'a', { status: 'approved', decidedAt: at(5), decidedBy: 'human' }));
    s.decisions.insert(openDecision('d2', 'a', { status: 'rejected', decidedAt: at(6), decidedBy: 'system' }));
    s.decisions.insert(openDecision('d3', 'a', { status: 'rejected', decidedAt: at(-5), decidedBy: 'human' }));
    s.decisions.insert(openDecision('d4', 'a'));

    expect(s.decisions.countDecidedSince(at(0), 'system')).toBe(1);
  });
});

describe('timeline repository', () => {
  test('stores entries and reads them back per run, oldest first', () => {
    const s = open();
    expect(s.timeline.tip()).toBeNull();
    s.timeline.insert(timelineEvent(1, 'a'));
    s.timeline.insert(timelineEvent(2, 'b', { mentions: ['fitter'], data: { exitCode: 0 } }));
    s.timeline.insert(timelineEvent(3, 'a', { kind: 'handoff' }));

    expect(s.timeline.forRun('a').map((e) => [e.seq, e.kind])).toEqual([
      [1, 'note'],
      [3, 'handoff'],
    ]);
    expect(s.timeline.forRun('b')[0]).toEqual(timelineEvent(2, 'b', { mentions: ['fitter'], data: { exitCode: 0 } }));
    expect(s.timeline.tip()).toEqual({ seq: 3, hash: timelineEvent(3, 'a').hash });
    expect(s.timeline.count()).toBe(3);
  });

  test('walks the whole ledger across pages and marks rows it cannot decode', () => {
    const s = open();
    s.transaction(() => {
      for (let seq = 1; seq <= 1_203; seq += 1) s.timeline.insert(timelineEvent(seq, 'a'));
    });
    s.db.prepare("UPDATE timeline SET mentions = 'not json' WHERE seq = 700").run();

    const rows = [...s.timeline.walk()];

    expect(rows).toHaveLength(1_203);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 1_203 }, (_, i) => i + 1));
    expect(rows[699]).toEqual({ seq: 700, event: null });
    expect(rows[700]?.event?.text).toBe('Entry 701');
  });
});

describe('state repositories', () => {
  test('the global pause is off until it is set', () => {
    const s = open();

    const before = s.settings.paused();
    s.settings.setPaused(true);
    const during = s.settings.paused();
    s.settings.setPaused(false);

    expect([before, during, s.settings.paused()]).toEqual([false, true, false]);
  });

  test('watch overrides replace each other', () => {
    const s = open();
    expect(s.watchOverrides.all()).toEqual(new Map());

    s.watchOverrides.set('w1', false);
    s.watchOverrides.set('w2', true);
    s.watchOverrides.set('w1', true);

    expect(s.watchOverrides.all()).toEqual(new Map([['w1', true], ['w2', true]]));
  });

  test('schedule state keeps the first sighting and the last firing', () => {
    const s = open();
    expect(s.scheduleState.get('nightly')).toBeNull();

    s.scheduleState.anchor('nightly', START);
    s.scheduleState.anchor('nightly', at(10));
    const anchored = s.scheduleState.get('nightly');
    s.scheduleState.markFired('nightly', at(30));
    s.scheduleState.markFired('never-anchored', at(40));

    expect(anchored).toEqual({ anchorAt: START, lastFiredAt: null });
    expect(s.scheduleState.get('nightly')).toEqual({ anchorAt: START, lastFiredAt: at(30) });
    expect(s.scheduleState.get('never-anchored')).toEqual({ anchorAt: at(40), lastFiredAt: at(40) });
  });
});
