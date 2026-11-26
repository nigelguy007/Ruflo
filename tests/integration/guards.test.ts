import { describe, expect, test } from 'vitest';
import { manualSignal } from '../../src/server/http/api-routes.js';
import { createRateLimiter } from '../../src/server/http/rate-limit.js';
import { isLoopbackHost, isSameOrigin, tokenMatches } from '../../src/server/http/security.js';
import { relativeFilePath } from '../../src/server/http/static.js';

describe('loopback host names', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.0.0.1:4310', true],
    ['Localhost:4310', true],
    ['[::1]', true],
    ['[::1]:65535', true],
    ['::1', false],
    ['127.0.0.2', false],
    ['localhost.', false],
    ['localhost:', false],
    ['localhost:123456', false],
    ['[::1', false],
    ['', false],
  ])('%j is loopback: %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe('same-origin check', () => {
  test.each([
    ['http://localhost:4310', 'localhost:4310', true],
    ['http://LOCALHOST:4310', 'localhost:4310', true],
    ['http://localhost', 'localhost:80', true],
    ['https://localhost', 'localhost:443', true],
    ['http://localhost:4310', 'localhost:4311', false],
    ['http://127.0.0.1:4310', 'localhost:4310', false],
    ['null', 'localhost:4310', false],
    ['file://', 'localhost', false],
    ['not a url', 'localhost', false],
  ])('%j against host %j: %s', (origin, host, expected) => {
    expect(isSameOrigin(origin, host)).toBe(expected);
  });
});

describe('token comparison', () => {
  test('matches only the exact token, whatever the lengths', () => {
    expect(tokenMatches('a'.repeat(32), 'a'.repeat(32))).toBe(true);
    expect(tokenMatches('a'.repeat(31), 'a'.repeat(32))).toBe(false);
    expect(tokenMatches('', 'a'.repeat(32))).toBe(false);
  });
});

describe('static paths', () => {
  test.each([
    ['/', ''],
    ['/assets/app.js', 'assets/app.js'],
    ['//assets///app.js', 'assets/app.js'],
    ['/app/runs/run%201', 'app/runs/run 1'],
    ['/..%2fpackage.json', null],
    ['/assets/.env', null],
    ['/a%5cb', null],
    ['/a%00b', null],
    ['/%E0%A4%A', null],
  ])('%j becomes %j', (path, expected) => {
    expect(relativeFilePath(path)).toBe(expected);
  });
});

describe('rate limiter', () => {
  test('refills at the configured rate and never above its capacity', () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 2, now: () => now });

    const first = [limiter.take('a'), limiter.take('a'), limiter.take('a')];
    now += 30_000;
    const afterHalfMinute = limiter.take('a');
    now += 10 * 60_000;
    const afterLongPause = [limiter.take('a'), limiter.take('a'), limiter.take('a')];

    expect(first.map((d) => d.allowed)).toEqual([true, true, false]);
    expect(first[2]).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(afterHalfMinute.allowed).toBe(true);
    expect(afterLongPause.map((d) => d.allowed)).toEqual([true, true, false]);
  });

  test('forgets the least recently seen client once it holds too many', () => {
    const limiter = createRateLimiter({ perMinute: 1, now: () => 0, maxClients: 2 });

    limiter.take('a');
    limiter.take('b');
    limiter.take('a');
    limiter.take('c');

    expect(limiter.size()).toBe(2);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });
});

describe('manual signals', () => {
  test('fill in what the sender left out', () => {
    const signal = manualSignal({ title: 'Cart total is NaN' });

    expect(signal).toMatchObject({ source: 'manual', kind: 'manual.run', severity: 'warning', url: null, payload: {} });
    expect(signal.fingerprint).toBe(manualSignal({ title: '  cart   TOTAL is nan ' }).fingerprint);
    expect(signal.fingerprint).not.toBe(manualSignal({ title: 'Cart total is zero' }).fingerprint);
  });

  test('keep what the sender gave', () => {
    const signal = manualSignal({
      title: 'x',
      kind: 'manual.error',
      severity: 'critical',
      fingerprint: 'fp',
      url: 'https://example.com',
      payload: { a: 1 },
    });

    expect(signal).toEqual({
      source: 'manual',
      kind: 'manual.error',
      title: 'x',
      fingerprint: 'fp',
      url: 'https://example.com',
      severity: 'critical',
      payload: { a: 1 },
    });
  });
});
