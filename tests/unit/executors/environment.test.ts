import { delimiter } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  absoluteSearchPath,
  inheritedEnvironment,
  minimalEnvironment,
  pathAndHome,
} from '../../../src/server/executors/environment.js';

const path = (...entries: string[]): string => entries.join(delimiter);

describe('absoluteSearchPath', () => {
  test('drops empty and relative entries, which would search the working directory', () => {
    expect(absoluteSearchPath(path('/usr/local/bin', '', '.', 'node_modules/.bin', '/usr/bin'))).toBe(
      path('/usr/local/bin', '/usr/bin'),
    );
  });

  test('keeps an already safe PATH as it is', () => {
    expect(absoluteSearchPath(path('/usr/bin', '/bin'))).toBe(path('/usr/bin', '/bin'));
    expect(absoluteSearchPath('')).toBe('');
  });
});

describe('inheritedEnvironment', () => {
  test('passes everything on except Switchyard’s own secrets', () => {
    const env = inheritedEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/op',
      ANTHROPIC_API_KEY: 'needed-by-the-session',
      SWITCHYARD_TOKEN: 'x'.repeat(32),
      SENTRY_CLIENT_SECRET: 's',
      GITHUB_WEBHOOK_SECRET: 'g',
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/op', ANTHROPIC_API_KEY: 'needed-by-the-session' });
  });

  test('cleans PATH so a binary planted in the checkout cannot shadow the real one', () => {
    expect(inheritedEnvironment({ PATH: path('.', '/usr/bin', '') }).PATH).toBe('/usr/bin');
  });

  test('works without a PATH at all', () => {
    expect(inheritedEnvironment({ HOME: '/home/op' })).toEqual({ HOME: '/home/op' });
  });

  test('reads process.env by default without leaking the API token', () => {
    vi.stubEnv('SWITCHYARD_TOKEN', 'y'.repeat(32));
    try {
      expect(inheritedEnvironment().SWITCHYARD_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('pathAndHome and minimalEnvironment', () => {
  const source = { PATH: path('/usr/bin', '.'), HOME: '/home/op', SECRET: 'nope', SWITCHYARD_TOKEN: 'nope' };

  test('pathAndHome keeps exactly PATH and HOME', () => {
    expect(pathAndHome(source)).toEqual({ PATH: '/usr/bin', HOME: '/home/op' });
  });

  test('minimalEnvironment adds CI=1 and nothing else', () => {
    expect(minimalEnvironment(source)).toEqual({ PATH: '/usr/bin', HOME: '/home/op', CI: '1' });
  });

  test('missing variables stay missing', () => {
    expect(minimalEnvironment({})).toEqual({ CI: '1' });
  });
});
