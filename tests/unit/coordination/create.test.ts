import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCoordination } from '../../../src/server/coordination/index.js';
import type { CoordinationOptions } from '../../../src/server/coordination/index.js';
import { DISCONNECTED_REASON } from '../../../src/server/coordination/ruflo.js';
import { rufloDataDir, rufloEnvironment } from '../../../src/server/coordination/session.js';
import type { Coordination } from '../../../src/server/ports.js';
import { capturingLogger, isAlive, makeConfig, makeTempDir, waitUntil } from '../executors/helpers.js';
import { readReport, stubCommand } from './support.js';

const LONG_NOTE =
  'Production error to shipped fix for "TypeError: cart.total is undefined" ended succeeded. Guarded the null cart.';

let temp: ReturnType<typeof makeTempDir>;
let opened: Coordination[] = [];

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(async () => {
  await Promise.all(opened.map((coordination) => coordination.close()));
  opened = [];
  vi.unstubAllEnvs();
  temp.cleanup();
});

function configFor(coordination: 'auto' | 'ruflo' | 'local', db = join(temp.dir, 'switchyard.db')): ReturnType<typeof makeConfig> {
  return makeConfig({ SWITCHYARD_COORDINATION: coordination, SWITCHYARD_DB: db });
}

async function start(
  coordination: 'auto' | 'ruflo' | 'local',
  mode: string,
  options: CoordinationOptions = {},
): Promise<{ memory: Coordination; entries: ReturnType<typeof capturingLogger>['entries']; report: string }> {
  const report = join(temp.dir, `${mode}-report.json`);
  const { log, entries } = capturingLogger();
  const memory = await createCoordination(configFor(coordination), log, { command: stubCommand(mode, report), ...options });
  opened.push(memory);
  return { memory, entries, report };
}

describe('createCoordination with a stub Ruflo server', () => {
  test('local mode never starts a server', async () => {
    const { memory, report } = await start('local', 'normal');
    expect(memory.kind).toBe('local');
    expect(existsSync(report)).toBe(false);
  });

  test('connects, stores, recalls the full note, routes and closes the child', async () => {
    const { memory, entries, report } = await start('auto', 'normal');
    expect(memory.kind).toBe('ruflo');
    expect(entries.find((entry) => entry.message === 'connected to Ruflo')?.fields).toMatchObject({
      version: '3.80.8-stub',
    });

    await memory.remember('fitter', 'run:1', LONG_NOTE, ['error-to-fix', 'succeeded']);
    await memory.remember('scout', 'run:2', 'cart total undefined, seen by another operator', []);
    const hits = await memory.recall('fitter', 'cart total undefined', 3);
    const advice = await memory.route('Fix TypeError: cart.total is undefined in checkout');

    expect(hits).toEqual([{ key: 'run:1', text: LONG_NOTE, score: 1 }]);
    expect(advice.tier).toBe(3);
    expect(advice.reason).toContain('tester agent');

    const { pid } = readReport(report);
    await memory.close();
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  test('runs the server in a data directory next to the database, with a minimal environment', async () => {
    vi.stubEnv('SWITCHYARD_TOKEN', 'a-very-secret-api-token-value');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-for-ruflo');
    const { report } = await start('auto', 'normal');

    const { cwd, env } = readReport(report);

    expect(cwd).toBe(join(temp.dir, 'ruflo'));
    expect(env).toEqual(rufloEnvironment());
    expect(Object.keys(env).sort()).toEqual(
      ['CLAUDE_FLOW_MODE', 'HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'npm_config_update_notifier'].sort(),
    );
    expect(env).toMatchObject({ CLAUDE_FLOW_MODE: 'v3', npm_config_update_notifier: 'false', USER: '', SHELL: '' });
  });

  test('uses a temporary data directory for an in-memory database and removes it on close', async () => {
    const report = join(temp.dir, 'memory-report.json');
    const memory = await createCoordination(configFor('ruflo', ':memory:'), capturingLogger().log, {
      command: stubCommand('normal', report),
    });
    const { cwd } = readReport(report);
    expect(cwd).not.toContain(temp.dir);
    expect(existsSync(cwd)).toBe(true);

    await memory.close();

    expect(existsSync(cwd)).toBe(false);
  });

  test('auto falls back to local memory when the server cannot be spawned', async () => {
    const { log, entries } = capturingLogger();
    const memory = await createCoordination(configFor('auto'), log, {
      command: { command: join(temp.dir, 'no-such-ruflo'), args: [] },
    });
    opened.push(memory);

    expect(memory.kind).toBe('local');
    expect(entries.map((entry) => entry.message)).toEqual(['Ruflo is unavailable; using local memory instead']);
    expect(String(entries[0]?.fields?.error)).toMatch(/^Ruflo did not start: .*ENOENT/);
  });

  test('ruflo mode throws when the server cannot be spawned', async () => {
    const attempt = createCoordination(configFor('ruflo'), capturingLogger().log, {
      command: { command: join(temp.dir, 'no-such-ruflo'), args: [] },
    });
    await expect(attempt).rejects.toThrow(/^Ruflo did not start/);
  });

  test('the start-up error includes the tail of what the server printed', async () => {
    const attempt = createCoordination(configFor('ruflo'), capturingLogger().log, {
      command: { command: process.execPath, args: ['-e', 'process.stderr.write("npm error 404 ruflo"); process.exit(1)'] },
      connectTimeoutMs: 5_000,
    });
    await expect(attempt).rejects.toThrow(/last output: npm error 404 ruflo/);
  });

  test('auto falls back, and kills the child, when the server lacks a required tool', async () => {
    const { memory, entries, report } = await start('auto', 'missing-tools');

    expect(memory.kind).toBe('local');
    expect(String(entries[0]?.fields?.error)).toContain('does not offer memory_search, memory_retrieve, hooks_route');
    const { pid } = readReport(report);
    expect(await waitUntil(() => !isAlive(pid), 6_000)).toBe(true);
  });

  test('ruflo mode gives up after the start-up timeout and kills the child', async () => {
    const report = join(temp.dir, 'hang-report.json');
    const startedAt = Date.now();
    const attempt = createCoordination(configFor('ruflo'), capturingLogger().log, {
      command: stubCommand('no-handshake', report),
      connectTimeoutMs: 400,
    });

    await expect(attempt).rejects.toThrow(/Ruflo did not start: .*timed out/i);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(existsSync(join(temp.dir, 'ruflo'))).toBe(true);
    const { pid } = readReport(report);
    expect(await waitUntil(() => !isAlive(pid), 6_000)).toBe(true);
  });

  test('a call that hangs times out without breaking the session', async () => {
    const { memory } = await start('auto', 'slow-search', { callTimeoutMs: 300 });
    const startedAt = Date.now();

    expect(await memory.recall('fitter', 'cart', 3)).toEqual([]);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect((await memory.route('task')).reason).toContain('tester agent');
  });

  test('answers that are not JSON degrade to the fallbacks', async () => {
    const { memory, entries } = await start('auto', 'garbage');

    await memory.remember('fitter', 'run:1', LONG_NOTE, []);
    expect(await memory.recall('fitter', 'cart', 3)).toEqual([]);
    expect((await memory.route('task')).tier).toBe(3);

    expect(entries.filter((entry) => entry.level === 'warn').map((entry) => entry.fields?.error)).toEqual([
      'tool result is not JSON',
      'tool result is not JSON',
      'tool result is not JSON',
    ]);
  });

  test('a server that dies mid-run is reported once and then left alone', async () => {
    const { memory, entries } = await start('auto', 'exit-on-search');

    expect(await memory.recall('fitter', 'cart', 3)).toEqual([]);
    await waitUntil(() => entries.some((entry) => entry.message.startsWith('the Ruflo server exited')));
    expect(await memory.route('task')).toEqual({ tier: 3, reason: DISCONNECTED_REASON });
    await memory.remember('fitter', 'run:1', 'note', []);

    const exits = entries.filter((entry) => entry.message.startsWith('the Ruflo server exited'));
    expect(exits).toHaveLength(1);
  });
});

describe('rufloEnvironment', () => {
  test('keeps PATH (absolute entries only) and HOME, blanks the SDK extras, adds Ruflo switches', () => {
    const env = rufloEnvironment(
      { PATH: `/usr/bin::.:/bin`, HOME: '/home/op', USER: 'op', SWITCHYARD_TOKEN: 'secret', GITHUB_TOKEN: 'ghp' },
      'linux',
    );
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/op',
      LOGNAME: '',
      SHELL: '',
      TERM: '',
      USER: '',
      npm_config_update_notifier: 'false',
      CLAUDE_FLOW_MODE: 'v3',
    });
  });

  test('leaves the Windows start-up variables to the SDK', () => {
    const env = rufloEnvironment({ PATH: 'C:\\node', HOME: 'C:\\Users\\op' }, 'win32');
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_FLOW_MODE', 'HOME', 'PATH', 'npm_config_update_notifier']);
  });
});

describe('rufloDataDir', () => {
  test('creates ruflo/ beside the database file', () => {
    const dir = rufloDataDir(join(temp.dir, 'nested', 'switchyard.db'));
    expect(dir).toEqual({ path: join(temp.dir, 'nested', 'ruflo'), temporary: false });
    expect(existsSync(dir.path)).toBe(true);
  });
});
