import { describe, expect, test } from 'vitest';
import { matchWatches, readPath, watchMatches } from '../../../src/server/engine/matching.js';
import { signal, watch } from './support.js';

describe('readPath', () => {
  test('follows a dotted path into nested objects', () => {
    const payload = { repository: { owner: { login: 'acme' } } };

    expect(readPath(payload, 'repository.owner.login')).toBe('acme');
  });

  test('returns undefined when any part of the path is missing', () => {
    const payload = { repository: { name: 'api' } };

    expect(readPath(payload, 'repository.owner.login')).toBeUndefined();
    expect(readPath(payload, 'nothing')).toBeUndefined();
  });

  test('does not walk through arrays, strings or null', () => {
    const payload = { list: ['a'], text: 'abc', gone: null };

    expect(readPath(payload, 'list.0')).toBeUndefined();
    expect(readPath(payload, 'text.length')).toBeUndefined();
    expect(readPath(payload, 'gone.anything')).toBeUndefined();
  });

  test('never reaches into a prototype', () => {
    expect(readPath({}, 'constructor.name')).toBeUndefined();
    expect(readPath({}, '__proto__')).toBeUndefined();
    expect(readPath({ a: {} }, 'a.toString')).toBeUndefined();
  });
});

describe('watchMatches', () => {
  test('accepts a signal from its source when it lists no kinds', () => {
    const anyKind = watch('w', 'p', { source: 'github', kinds: [] });

    expect(watchMatches(anyKind, signal({ source: 'github', kind: 'push' }))).toBe(true);
    expect(watchMatches(anyKind, signal({ source: 'github', kind: 'check_run.failed' }))).toBe(true);
  });

  test('ignores signals from another source', () => {
    const githubOnly = watch('w', 'p', { source: 'github' });

    expect(watchMatches(githubOnly, signal({ source: 'sentry' }))).toBe(false);
  });

  test('accepts only the kinds it lists', () => {
    const failures = watch('w', 'p', { source: 'github', kinds: ['check_run.failed'] });

    expect(watchMatches(failures, signal({ source: 'github', kind: 'check_run.failed' }))).toBe(true);
    expect(watchMatches(failures, signal({ source: 'github', kind: 'pull_request.opened' }))).toBe(false);
  });

  test('requires every dotted-path filter to equal the payload value exactly', () => {
    const scoped = watch('w', 'p', {
      match: { 'repository.name': 'api', 'check.conclusion': 'failure' },
    });
    const matching = { repository: { name: 'api' }, check: { conclusion: 'failure' } };
    const otherRepo = { repository: { name: 'api-gateway' }, check: { conclusion: 'failure' } };
    const halfMatch = { repository: { name: 'api' }, check: { conclusion: 'success' } };

    expect(watchMatches(scoped, signal({ payload: matching }))).toBe(true);
    expect(watchMatches(scoped, signal({ payload: otherRepo }))).toBe(false);
    expect(watchMatches(scoped, signal({ payload: halfMatch }))).toBe(false);
    expect(watchMatches(scoped, signal({ payload: {} }))).toBe(false);
  });

  test('compares numbers and booleans by their text, and never matches objects', () => {
    const typed = watch('w', 'p', { match: { 'pr.number': '42', 'pr.draft': 'false' } });
    const loose = watch('w2', 'p', { match: { pr: '[object Object]' } });

    expect(watchMatches(typed, signal({ payload: { pr: { number: 42, draft: false } } }))).toBe(true);
    expect(watchMatches(typed, signal({ payload: { pr: { number: 43, draft: false } } }))).toBe(false);
    expect(watchMatches(loose, signal({ payload: { pr: { number: 42 } } }))).toBe(false);
  });

  test('never matches while disabled', () => {
    const disabled = watch('w', 'p', { enabled: false });

    expect(watchMatches(disabled, signal())).toBe(false);
  });
});

describe('matchWatches', () => {
  test('returns every matching watch in the order they are listed', () => {
    const watches = [watch('a', 'p1'), watch('b', 'p2', { source: 'sentry' }), watch('c', 'p3')];

    const matched = matchWatches(watches, signal());

    expect(matched.map((w) => w.id)).toEqual(['a', 'c']);
  });

  test('keeps one watch per playbook so a signal cannot start the same playbook twice', () => {
    const watches = [watch('first', 'p1'), watch('second', 'p1'), watch('third', 'p2')];

    const matched = matchWatches(watches, signal());

    expect(matched.map((w) => w.id)).toEqual(['first', 'third']);
  });
});
