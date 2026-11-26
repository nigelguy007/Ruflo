import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runProcess } from '../../../src/server/executors/process.js';
import type { ProcessRequest } from '../../../src/server/executors/process.js';
import { isAlive, makeTempDir, waitUntil, writeExecutable } from './helpers.js';

let temp: ReturnType<typeof makeTempDir>;
const strays: number[] = [];

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  temp.cleanup();
});

function request(command: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return {
    command,
    args: [],
    cwd: temp.dir,
    env: { PATH: process.env.PATH ?? '' },
    input: null,
    abort: new AbortController().signal,
    timeoutMs: 0,
    capture: 'separate',
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    ...overrides,
  };
}

function script(name: string, source: string): string {
  return writeExecutable(temp.dir, name, source);
}

function readPid(file: string): number {
  return Number(readFileSync(file, 'utf8'));
}

/** A child that records its pid in `pid.txt` and then waits forever. */
const SLEEPER = `require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000);`;

describe('runProcess', () => {
  test('captures stdout and stderr separately with the exit code', async () => {
    const bin = script('both', `process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;`);
    const outcome = await runProcess(request(bin));
    expect(outcome).toMatchObject({ exitCode: 3, signal: null, stdout: 'out', stderr: 'err', spawnError: null });
    expect(outcome).toMatchObject({ timedOut: false, aborted: false, stdoutTruncated: false });
  });

  test('merges stderr into stdout in arrival order when asked', async () => {
    const bin = script(
      'merged',
      `(async () => {
         process.stdout.write('one ');
         await new Promise((r) => setTimeout(r, 50));
         process.stderr.write('two ');
         await new Promise((r) => setTimeout(r, 50));
         process.stdout.write('three');
       })();`,
    );
    const outcome = await runProcess(request(bin, { capture: 'merged' }));
    expect(outcome.stdout).toBe('one two three');
    expect(outcome.stderr).toBe('');
  });

  test('writes the input to stdin and closes it', async () => {
    const bin = script('echo', `process.stdout.write('got:' + require('fs').readFileSync(0, 'utf8'));`);
    expect((await runProcess(request(bin, { input: 'the brief' }))).stdout).toBe('got:the brief');
  });

  test('gives the child no stdin when the input is null', async () => {
    const bin = script('nostdin', `process.stdout.write(String(require('fs').readFileSync(0).length));`);
    expect((await runProcess(request(bin, { input: null }))).stdout).toBe('0');
  });

  test('survives a child that exits without reading a large input', async () => {
    const bin = script('ignores', `process.exit(0);`);
    const outcome = await runProcess(request(bin, { input: 'x'.repeat(8 * 1024 * 1024) }));
    expect(outcome.exitCode).toBe(0);
  });

  test('reports the signal of a child that was killed', async () => {
    const bin = script('suicide', `process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);`);
    expect(await runProcess(request(bin))).toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: false });
  });

  test('keeps only the tail of a chatty child', async () => {
    const bin = script('chatty', `process.stdout.write('x'.repeat(10000)); process.stdout.write('THE-END');`);
    const outcome = await runProcess(request(bin, { maxStdoutBytes: 1_000 }));
    expect(outcome.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(1_000);
    expect(outcome.stdout.endsWith('THE-END')).toBe(true);
  });

  test('reports a binary that does not exist instead of throwing', async () => {
    const outcome = await runProcess(request(join(temp.dir, 'missing')));
    expect(outcome.exitCode).toBeNull();
    expect(outcome.spawnError).toMatch(/ENOENT/);
  });

  test('reports a working directory that does not exist', async () => {
    const outcome = await runProcess(request(process.execPath, { args: ['-e', ''], cwd: join(temp.dir, 'gone') }));
    expect(outcome.spawnError).toMatch(/ENOENT/);
  });

  test('stops a child at the timeout with SIGTERM', async () => {
    const outcome = await runProcess(request(script('sleeper', SLEEPER), { timeoutMs: 200, killGraceMs: 100 }));
    expect(outcome).toMatchObject({ timedOut: true, aborted: false, signal: 'SIGTERM' });
    expect(isAlive(readPid(join(temp.dir, 'pid.txt')))).toBe(false);
  });

  test('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const bin = script('stubborn', `process.on('SIGTERM', () => {}); ${SLEEPER}`);
    const outcome = await runProcess(request(bin, { timeoutMs: 200, killGraceMs: 100 }));
    expect(outcome).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  });

  test('kills the child, and its children, when aborted', async () => {
    const bin = script(
      'parent',
      `const { spawn } = require('child_process');
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       require('fs').writeFileSync('grandchild.txt', String(child.pid));
       ${SLEEPER}`,
    );
    const controller = new AbortController();
    const running = runProcess(request(bin, { abort: controller.signal }));
    expect(await waitUntil(() => existsSync(join(temp.dir, 'pid.txt')))).toBe(true);
    const pids = [readPid(join(temp.dir, 'pid.txt')), readPid(join(temp.dir, 'grandchild.txt'))];
    strays.push(...pids);

    controller.abort();
    const outcome = await running;

    expect(outcome).toMatchObject({ aborted: true, timedOut: false });
    expect(await waitUntil(() => pids.every((pid) => !isAlive(pid)))).toBe(true);
  });

  test('does not start anything when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runProcess(request(script('never', SLEEPER), { abort: controller.signal }));
    expect(outcome).toMatchObject({ aborted: true, exitCode: null, spawnError: null });
    expect(existsSync(join(temp.dir, 'pid.txt'))).toBe(false);
  });

  test('settles even when an escaped grandchild keeps the pipes open', async () => {
    const bin = script(
      'escape',
      `const { spawn } = require('child_process');
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' });
       require('fs').writeFileSync('escaped.txt', String(child.pid));
       ${SLEEPER}`,
    );
    const startedAt = Date.now();
    const running = runProcess(request(bin, { timeoutMs: 300, killGraceMs: 100 }));
    expect(await waitUntil(() => existsSync(join(temp.dir, 'escaped.txt')))).toBe(true);
    strays.push(readPid(join(temp.dir, 'escaped.txt')));

    const outcome = await running;

    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });
});
