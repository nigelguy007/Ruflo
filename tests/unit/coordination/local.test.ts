import { describe, expect, test } from 'vitest';
import {
  LOCAL_MAX_ENTRIES,
  LOCAL_ROUTE_REASON,
  LocalCoordination,
  keywords,
  overlapScore,
} from '../../../src/server/coordination/local.js';

describe('keywords', () => {
  test('lower-cases words and drops stop words and single characters', () => {
    expect([...keywords('TypeError: cart.total is undefined in a Checkout')]).toEqual([
      'typeerror',
      'cart',
      'total',
      'undefined',
      'checkout',
    ]);
  });

  test('keeps letters and digits from any script', () => {
    expect([...keywords('Fehler über 404 — ошибка')]).toEqual(['fehler', 'über', '404', 'ошибка']);
  });
});

describe('overlapScore', () => {
  test('is the share of query keywords the entry contains', () => {
    expect(overlapScore(keywords('cart total undefined'), keywords('cart total was null'))).toBeCloseTo(2 / 3);
  });

  test('is 0 for a query without keywords', () => {
    expect(overlapScore(keywords('the a of'), keywords('anything'))).toBe(0);
  });
});

describe('LocalCoordination', () => {
  test('reports itself as local', () => {
    expect(new LocalCoordination().kind).toBe('local');
  });

  test('recalls the closest notes first and leaves out notes with no shared keyword', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'run:1', 'Fixed cart total undefined in checkout', []);
    await memory.remember('fitter', 'run:2', 'Bumped lodash after the nightly check', []);
    await memory.remember('fitter', 'run:3', 'Checkout cart crashed again', []);

    const hits = await memory.recall('fitter', 'TypeError: cart.total is undefined', 5);

    expect(hits.map((hit) => hit.key)).toEqual(['run:1', 'run:3']);
    expect(hits[0]?.score).toBe(3 / 4);
    expect(hits[1]?.score).toBe(1 / 4);
  });

  test('honours the limit, including 0', async () => {
    const memory = new LocalCoordination();
    for (const n of [1, 2, 3]) await memory.remember('fitter', `run:${n}`, `cart note ${n}`, []);
    expect(await memory.recall('fitter', 'cart', 2)).toHaveLength(2);
    expect(await memory.recall('fitter', 'cart', 0)).toEqual([]);
    expect(await memory.recall('fitter', 'cart', -1)).toEqual([]);
  });

  test('prefers the newer note when scores tie', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'old', 'cart crash', []);
    await memory.remember('fitter', 'new', 'cart crash', []);
    expect((await memory.recall('fitter', 'cart crash', 2)).map((hit) => hit.key)).toEqual(['new', 'old']);
  });

  test('keeps each operator to its own notes', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'run:1', 'cart crash', []);
    expect(await memory.recall('scout', 'cart crash', 3)).toEqual([]);
  });

  test('matches on tags as well as text', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'run:1', 'Opened a pull request', ['error-to-fix', 'sentry']);
    expect(await memory.recall('fitter', 'sentry', 1)).toHaveLength(1);
  });

  test('replaces a note stored again under the same key', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'run:1', 'cart first version', []);
    await memory.remember('fitter', 'run:1', 'cart second version', []);
    const hits = await memory.recall('fitter', 'cart', 5);
    expect(hits).toEqual([{ key: 'run:1', text: 'cart second version', score: 1 }]);
  });

  test('drops the oldest notes beyond the bound', async () => {
    const memory = new LocalCoordination(3);
    for (const n of [1, 2, 3, 4, 5]) await memory.remember('fitter', `run:${n}`, `cart ${n}`, []);
    const keys = (await memory.recall('fitter', 'cart', 10)).map((hit) => hit.key).sort();
    expect(keys).toEqual(['run:3', 'run:4', 'run:5']);
  });

  test('is bounded at 200 notes per operator by default', async () => {
    const memory = new LocalCoordination();
    for (let n = 0; n <= LOCAL_MAX_ENTRIES; n += 1) await memory.remember('fitter', `run:${n}`, 'cart', []);
    const hits = await memory.recall('fitter', 'cart', 1_000);
    expect(LOCAL_MAX_ENTRIES).toBe(200);
    expect(hits).toHaveLength(200);
    expect(hits.map((hit) => hit.key)).not.toContain('run:0');
  });

  test('caps the stored text', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'long', `cart ${'x'.repeat(10_000)}`, []);
    const [hit] = await memory.recall('fitter', 'cart', 1);
    expect(hit?.text).toHaveLength(4_000);
  });

  test('routes everything to tier 3 and says why', async () => {
    expect(await new LocalCoordination().route('convert var to const')).toEqual({
      tier: 3,
      reason: LOCAL_ROUTE_REASON,
    });
  });

  test('forgets everything on close', async () => {
    const memory = new LocalCoordination();
    await memory.remember('fitter', 'run:1', 'cart', []);
    await memory.close();
    expect(await memory.recall('fitter', 'cart', 1)).toEqual([]);
  });
});
