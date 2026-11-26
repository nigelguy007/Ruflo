import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_OUTPUT_BYTES,
  createDryRunCommandRunner,
  createLiveCommandRunner,
  refusalReason,
} from '../../../src/server/executors/command-runner.js';
import { minimalEnvironment } from '../../../src/server/executors/environment.js';
import { createCommandRunner } from '../../../src/server/executors/index.js';
import type { CommandOptions, CommandRunner } from '../../../src/server/ports.js';
import { capturingLogger, isAlive, makeConfig, makeTempDir, waitUntil } from './helpers.js';

let temp: ReturnType<typeof makeTempDir>;

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(() => {
  vi.unstubAllEnvs();
  temp.cleanup();
});

function options(overrides: Partial<CommandOptions> = {}): CommandOptions {
  return { cwd: temp.dir, timeoutMs: 10_000, abort: new AbortController().signal, ...overrides };
}

function liveConfig(env: Record<string, string> = {}): ReturnType<typeof makeConfig> {
  return makeConfig({ SWITCHYARD_MODE: 'live', SWITCHYARD_WORKDIR: temp.dir, ...env });
}

function live(env: Record<string, string> = {}): { runner: CommandRunner; entries: ReturnType<typeof capturingLogger>['entries'] } {
  const { log, entries } = capturingLogger();
  return { runner: createLiveCommandRunner(liveConfig(env), log, { killGraceMs: 100 }), entries };
}

/** node -e that would create `marker` in the working directory if it ever ran. */
function touch(marker: string): string[] {
  return ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
}

describe('refusalReason', () => {
  const allowed = ['git', 'node'];

  test('allows a listed binary by name', () => {
    expect(refusalReason(['git', 'status'], allowed)).toBeNull();
  });

  test('refuses empty commands, odd arguments, paths and unlisted binaries', () => {
    expect(refusalReason([], allowed)).toBe('the command is empty');
    expect(refusalReason([''], allowed)).toBe('the command is empty');
    expect(refusalReason(['git', 'a\0b'], allowed)).toBe('an argument is not a plain string');
    expect(refusalReason(['git', 42 as unknown as string], allowed)).toBe('an argument is not a plain string');
    expect(refusalReason(['/usr/bin/git'], allowed)).toContain('contains a path separator');
    expect(refusalReason(['..\\git'], allowed)).toContain('contains a path separator');
    expect(refusalReason(['rm', '-rf', '.'], allowed)).toBe('"rm" is not in SWITCHYARD_ALLOWED_COMMANDS (git, node)');
    expect(refusalReason(['git'], [])).toBe('"git" is not in SWITCHYARD_ALLOWED_COMMANDS (empty)');
  });
});

describe('dry-run command runner (simulate mode)', () => {
  const runner = createDryRunCommandRunner(makeConfig());

  test('describes the command and executes nothing', async () => {
    const result = await runner.run(['node', ...touch('marker')], options());
    expect(result).toMatchObject({ exitCode: 0, dryRun: true, timedOut: false });
    expect(result.output).toMatch(/^dry run: would execute node -e /);
    expect(existsSync(join(temp.dir, 'marker'))).toBe(false);
  });

  test('quotes arguments the way a person would type them', async () => {
    const result = await runner.run(['git', 'commit', '-m', 'fix the cart'], options());
    expect(result.output).toBe('dry run: would execute git commit -m "fix the cart"');
  });

  test('warns when live mode would refuse the command', async () => {
    const result = await runner.run(['rm', '-rf', '/'], options());
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('(live mode would refuse it: "rm" is not in SWITCHYARD_ALLOWED_COMMANDS');
  });

  test('is what createCommandRunner gives in simulate mode', async () => {
    const result = await createCommandRunner(makeConfig(), capturingLogger().log).run(['npm', 'test'], options());
    expect(result).toEqual({ exitCode: 0, output: 'dry run: would execute npm test', dryRun: true, timedOut: false });
  });
});

describe('live command runner', () => {
  test('runs an allow-listed binary in the working directory', async () => {
    const result = await live().runner.run(['node', '-e', 'process.stdout.write(process.cwd())'], options());
    expect(result).toEqual({ exitCode: 0, output: realpathSync(temp.dir), dryRun: false, timedOut: false });
  });

  test('is what createCommandRunner gives in live mode', async () => {
    const runner = createCommandRunner(liveConfig(), capturingLogger().log);
    expect((await runner.run(['node', '-e', 'process.stdout.write("ok")'], options())).output).toBe('ok');
  });

  test('refuses a binary that is not allow-listed with 126 and runs nothing', async () => {
    const { runner, entries } = live();
    const result = await runner.run(['sh', '-c', 'touch marker'], options());
    expect(result).toEqual({
      exitCode: 126,
      output: 'refused: "sh" is not in SWITCHYARD_ALLOWED_COMMANDS (git, npm, pnpm, node, gh). Nothing was executed.',
      dryRun: false,
      timedOut: false,
      executed: false,
    });
    expect(existsSync(join(temp.dir, 'marker'))).toBe(false);
    expect(entries).toEqual([
      { level: 'warn', message: 'command refused', fields: { command: 'sh', reason: expect.any(String) } },
    ]);
  });

  test('refuses a path even when that exact path is allow-listed', async () => {
    const { runner } = live({ SWITCHYARD_ALLOWED_COMMANDS: `${process.execPath},./node,node` });
    for (const binary of [process.execPath, './node', 'bin\\node']) {
      const result = await runner.run([binary, ...touch('marker')], options());
      expect(result.exitCode, binary).toBe(126);
      expect(result.executed, binary).toBe(false);
      expect(result.output, binary).toContain('contains a path separator');
    }
    expect(existsSync(join(temp.dir, 'marker'))).toBe(false);
  });

  test('refuses an empty command, a NUL byte and a missing working directory', async () => {
    const { runner } = live();
    const empty = await runner.run([], options());
    const nul = await runner.run(['node', '-e', '1\0'], options());
    const noCwd = await runner.run(['node', ...touch('marker')], options({ cwd: null }));
    expect([empty.exitCode, nul.exitCode, noCwd.exitCode]).toEqual([126, 126, 126]);
    expect([empty.executed, nul.executed, noCwd.executed]).toEqual([false, false, false]);
    expect(noCwd.output).toBe('refused: no working directory was given. Nothing was executed.');
  });

  test('passes arguments verbatim, without a shell', async () => {
    const hostile = '$(touch pwned) && echo hi; `touch also` *';
    const result = await live().runner.run(['node', '-e', 'process.stdout.write(process.argv[1])', hostile], options());
    expect(result.output).toBe(hostile);
    expect(existsSync(join(temp.dir, 'pwned'))).toBe(false);
    expect(existsSync(join(temp.dir, 'also'))).toBe(false);
  });

  test('gives the command PATH, HOME and CI=1 only', async () => {
    vi.stubEnv('SWITCHYARD_TOKEN', 'z'.repeat(32));
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-not-for-commands');
    const result = await live().runner.run(['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'], options());
    expect(JSON.parse(result.output)).toEqual(minimalEnvironment());
  });

  test('merges stderr into the output and passes the exit code through', async () => {
    const script = 'process.stdout.write("out "); process.stderr.write("err"); process.exitCode = 5;';
    const result = await live().runner.run(['node', '-e', script], options());
    expect(result).toEqual({ exitCode: 5, output: 'out err', dryRun: false, timedOut: false });
  });

  test('reports a command killed by a signal as 128 + its number', async () => {
    const script = 'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);';
    expect((await live().runner.run(['node', '-e', script], options())).exitCode).toBe(143);
  });

  test('a timeout kills the command, sets timedOut and keeps what it printed', async () => {
    const script = 'process.stdout.write("partial output"); setInterval(() => {}, 1000);';
    const result = await live().runner.run(['node', '-e', script], options({ timeoutMs: 300 }));
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.output).toMatch(/^partial output\n\[timed out after 0s; the command was killed\]$/);
  });

  test('caps the output at 64 KB and keeps the tail', async () => {
    const script = 'process.stdout.write("x".repeat(200000) + "THE-END")';
    const result = await live().runner.run(['node', '-e', script], options());
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(result.output.startsWith('[earlier output dropped; showing the last 64 KB]\n')).toBe(true);
    expect(result.output.endsWith('THE-END')).toBe(true);
  });

  test('a capped, timed-out command still fits inside the cap', async () => {
    const script = 'process.stdout.write("y".repeat(200000)); setInterval(() => {}, 1000);';
    const result = await live().runner.run(['node', '-e', script], options({ timeoutMs: 500 }));
    expect(result.timedOut).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(result.output).toMatch(/^\[earlier output dropped[^\n]*\ny+\n\[timed out after/);
  });

  test('abort kills the command and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const script = 'require("fs").writeFileSync("pid.txt", String(process.pid)); setInterval(() => {}, 1000);';
    const running = live().runner.run(['node', '-e', script], options({ abort: controller.signal }));
    expect(await waitUntil(() => existsSync(join(temp.dir, 'pid.txt')))).toBe(true);
    const pid = Number(readFileSync(join(temp.dir, 'pid.txt'), 'utf8'));

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  test('an abort before the start rejects and runs nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const running = live().runner.run(['node', ...touch('marker')], options({ abort: controller.signal }));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(temp.dir, 'marker'))).toBe(false);
  });

  test('an allow-listed binary that is not installed exits 127', async () => {
    const { runner } = live({ SWITCHYARD_ALLOWED_COMMANDS: 'switchyard-no-such-binary' });
    const result = await runner.run(['switchyard-no-such-binary'], options());
    expect(result.exitCode).toBe(127);
    expect(result.executed).toBe(false);
    expect(result.output).toMatch(/^could not start "switchyard-no-such-binary": .*ENOENT/);
  });

  test('a working directory that does not exist is reported as not run, with the made-up 127', async () => {
    const result = await live().runner.run(['node', ...touch('marker')], options({ cwd: join(temp.dir, 'gone') }));

    expect(result.exitCode).toBe(127);
    expect(result.executed).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.output).toMatch(/^could not start "node": /);
  });

  test('a command that ran is never marked as not executed, whatever it returned', async () => {
    const { runner } = live();
    const failed = await runner.run(['node', '-e', 'process.exit(3)'], options());
    const killed = await runner.run(['node', '-e', 'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000)'], options());
    const timedOut = await runner.run(['node', '-e', 'setInterval(() => {}, 1000)'], options({ timeoutMs: 200 }));

    expect([failed.exitCode, killed.exitCode, timedOut.exitCode]).toEqual([3, 143, 124]);
    for (const result of [failed, killed, timedOut]) expect(result.executed).not.toBe(false);
  });

  test('a dry run is not a refusal: nothing ran, but it says so with dryRun and not executed', async () => {
    const result = await createDryRunCommandRunner(makeConfig()).run(['rm', '-rf', '/'], options());

    expect(result.dryRun).toBe(true);
    expect(result.executed).toBeUndefined();
  });

  test('a timeout that is not a positive number falls back to the default', async () => {
    const { runner } = live();
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const result = await runner.run(['node', '-e', 'process.stdout.write("done")'], options({ timeoutMs }));
      expect(result, String(timeoutMs)).toMatchObject({ exitCode: 0, output: 'done', timedOut: false });
    }
  });

  test('logs the binary and the outcome, never the arguments', async () => {
    const { runner, entries } = live();
    await runner.run(['node', '-e', 'process.exit(0)', 'token=abc123'], options());
    expect(entries).toEqual([
      {
        level: 'info',
        message: 'command finished',
        fields: { command: 'node', exitCode: 0, timedOut: false, durationMs: expect.any(Number) },
      },
    ]);
  });
});
