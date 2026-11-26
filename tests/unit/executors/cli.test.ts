import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { claudeProfile, codexProfile, createCliExecutor } from '../../../src/server/executors/cli.js';
import type { CliProfile } from '../../../src/server/executors/cli.js';
import { createExecutors } from '../../../src/server/executors/index.js';
import { capturingLogger, isAlive, makeConfig, makeContext, makeTempDir, waitUntil, writeExecutable } from './helpers.js';

const FENCE = '```';
const BLOCK = {
  summary: 'Added a failing regression test, then guarded the null cart.',
  artifacts: [{ kind: 'pr', label: 'Pull request', value: 'https://github.com/acme/shop/pull/7' }],
  claims: [{ label: 'Regression test', detail: 'Fails on main, passes on the branch.', ok: true }],
};
const FINAL_MESSAGE = `I looked at the cart code.\n${FENCE}json\n${JSON.stringify(BLOCK, null, 2)}\n${FENCE}\n`;
const CLAUDE_OK = JSON.stringify({ type: 'result', result: FINAL_MESSAGE, is_error: false, total_cost_usd: 0.12 });

let temp: ReturnType<typeof makeTempDir>;

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(() => {
  vi.unstubAllEnvs();
  temp.cleanup();
});

interface Behaviour {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}

/** A stand-in session binary: records argv, stdin, env and pid in its cwd, then behaves as told. */
function stubBinary(name: string, behaviour: Behaviour): string {
  const ending = behaviour.hang ? 'setInterval(() => {}, 1000);' : `process.exitCode = ${behaviour.exitCode ?? 0};`;
  return writeExecutable(
    temp.dir,
    name,
    [
      `const fs = require('fs');`,
      `fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));`,
      `fs.writeFileSync('stdin.txt', fs.readFileSync(0, 'utf8'));`,
      `fs.writeFileSync('env.json', JSON.stringify(process.env));`,
      `fs.writeFileSync('pid.txt', String(process.pid));`,
      `process.stdout.write(${JSON.stringify(behaviour.stdout ?? '')});`,
      `process.stderr.write(${JSON.stringify(behaviour.stderr ?? '')});`,
      ending,
    ].join('\n'),
  );
}

function liveConfig(env: Record<string, string> = {}): ReturnType<typeof makeConfig> {
  return makeConfig({ SWITCHYARD_MODE: 'live', SWITCHYARD_WORKDIR: temp.dir, ...env });
}

function claudeWith(behaviour: Behaviour): CliProfile {
  return claudeProfile(liveConfig({ SWITCHYARD_CLAUDE_BIN: stubBinary('claude', behaviour) }));
}

function context(): ReturnType<typeof makeContext> {
  return makeContext({ workdir: temp.dir });
}

function recorded(file: string): string {
  return readFileSync(join(temp.dir, file), 'utf8');
}

describe('CLI profiles', () => {
  test('Claude runs in print mode with JSON output and accepts edits, never bypassing permissions', () => {
    const profile = claudeProfile(liveConfig({ SWITCHYARD_CLAUDE_BIN: '/opt/claude' }));
    expect(profile).toMatchObject({ harness: 'claude', label: 'Claude', bin: '/opt/claude', binSetting: 'SWITCHYARD_CLAUDE_BIN' });
    expect(profile.args[0]).toBe('-p');
    expect(profile.args.slice(2)).toEqual(['--output-format', 'json', '--permission-mode', 'acceptEdits']);
    expect(profile.args.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });

  test('Codex runs exec with a workspace-write sandbox and reads the prompt from stdin', () => {
    const profile = codexProfile(liveConfig({ SWITCHYARD_CODEX_BIN: 'codex-cli' }));
    expect(profile).toMatchObject({ harness: 'codex', label: 'Codex', bin: 'codex-cli', binSetting: 'SWITCHYARD_CODEX_BIN' });
    expect(profile.args).toEqual(['exec', '--sandbox', 'workspace-write', '-']);
  });
});

describe('createCliExecutor', () => {
  test('turns a Claude result envelope with a fenced JSON block into a step result', async () => {
    const executor = createCliExecutor(claudeWith({ stdout: CLAUDE_OK }), capturingLogger().log);
    const result = await executor.run(context(), new AbortController().signal);

    expect(executor.harness).toBe('claude');
    expect(result).toEqual({
      ok: true,
      summary: BLOCK.summary,
      artifacts: BLOCK.artifacts,
      claims: BLOCK.claims,
      costUsd: 0.12,
    });
  });

  test('sends the prompt on stdin, not in argv, from the working directory', async () => {
    const profile = claudeWith({ stdout: CLAUDE_OK });
    await createCliExecutor(profile, capturingLogger().log).run(context(), new AbortController().signal);

    const argv: unknown = JSON.parse(recorded('argv.json'));
    const stdin = recorded('stdin.txt');
    expect(argv).toEqual([...profile.args]);
    expect(stdin).toContain(context().step.instruction);
    expect(stdin).toContain('<untrusted-signal>');
    expect(JSON.stringify(argv)).not.toContain(context().step.instruction);
  });

  test('does not hand the session Switchyard’s own secrets', async () => {
    vi.stubEnv('SWITCHYARD_TOKEN', 't'.repeat(32));
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'hook-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'the-session-needs-this');
    await createCliExecutor(claudeWith({ stdout: CLAUDE_OK }), capturingLogger().log).run(
      context(),
      new AbortController().signal,
    );

    const env = JSON.parse(recorded('env.json')) as Record<string, string>;
    expect(env.SWITCHYARD_TOKEN).toBeUndefined();
    expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('the-session-needs-this');
  });

  test('reads Codex plain output, where the final message is all of stdout', async () => {
    const profile = codexProfile(
      liveConfig({ SWITCHYARD_CODEX_BIN: stubBinary('codex', { stdout: FINAL_MESSAGE, stderr: 'thinking...' }) }),
    );
    const result = await createCliExecutor(profile, capturingLogger().log).run(context(), new AbortController().signal);
    expect(result).toEqual({ ok: true, summary: BLOCK.summary, artifacts: BLOCK.artifacts, claims: BLOCK.claims });
  });

  test('a non-zero exit fails the step even when the session claims success', async () => {
    const result = await createCliExecutor(claudeWith({ stdout: CLAUDE_OK, exitCode: 1 }), capturingLogger().log).run(
      context(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(BLOCK.summary);
  });

  test('an error reported by Claude fails the step', async () => {
    const stdout = JSON.stringify({ type: 'result', result: FINAL_MESSAGE, is_error: true });
    const result = await createCliExecutor(claudeWith({ stdout }), capturingLogger().log).run(
      context(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });

  test('garbage output falls back to a truncated summary', async () => {
    const stdout = `Some rambling without a result block. ${'blah '.repeat(400)}`;
    const result = await createCliExecutor(claudeWith({ stdout }), capturingLogger().log).run(
      context(),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: true, artifacts: [], claims: [] });
    expect(result.summary.startsWith('Some rambling without a result block.')).toBe(true);
    expect(result.summary).toHaveLength(600);
    expect(result.summary.endsWith('…')).toBe(true);
  });

  test('no output and a failure exit summarises the exit code and the end of stderr', async () => {
    const result = await createCliExecutor(
      claudeWith({ stderr: 'Error: not logged in.\nRun claude login.', exitCode: 2 }),
      capturingLogger().log,
    ).run(context(), new AbortController().signal);
    expect(result).toEqual({
      ok: false,
      summary: 'The Claude session exited with code 2 and printed no result. Last error output: Error: not logged in. Run claude login.',
      artifacts: [],
      claims: [],
    });
  });

  test('abort kills the session and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const executor = createCliExecutor(claudeWith({ hang: true }), capturingLogger().log, { killGraceMs: 100 });
    const running = executor.run(context(), controller.signal);
    expect(await waitUntil(() => existsSync(join(temp.dir, 'pid.txt')))).toBe(true);
    const pid = Number(recorded('pid.txt'));

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  test('an abort before the start rejects and starts nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const running = createCliExecutor(claudeWith({ stdout: CLAUDE_OK }), capturingLogger().log).run(
      context(),
      controller.signal,
    );
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(temp.dir, 'pid.txt'))).toBe(false);
  });

  test('without a working directory the session is not started', async () => {
    const result = await createCliExecutor(claudeWith({ stdout: CLAUDE_OK }), capturingLogger().log).run(
      makeContext({ workdir: null }),
      new AbortController().signal,
    );
    expect(result).toEqual({
      ok: false,
      summary: 'No working directory was given, so the Claude session was not started.',
      artifacts: [],
      claims: [],
    });
    expect(existsSync(join(temp.dir, 'pid.txt'))).toBe(false);
  });

  test('a binary that cannot start fails the step and names the setting', async () => {
    const { log, entries } = capturingLogger();
    const profile = claudeProfile(liveConfig({ SWITCHYARD_CLAUDE_BIN: join(temp.dir, 'no-claude-here') }));
    const result = await createCliExecutor(profile, log).run(context(), new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/^Could not start the Claude session: .*ENOENT.*\. Check SWITCHYARD_CLAUDE_BIN\.$/);
    expect(entries.map((entry) => entry.message)).toEqual(['agent session could not start']);
  });

  test('logs the outcome without the prompt or the output', async () => {
    const { log, entries } = capturingLogger();
    await createCliExecutor(claudeWith({ stdout: CLAUDE_OK }), log).run(context(), new AbortController().signal);

    expect(entries).toEqual([
      {
        level: 'info',
        message: 'agent session finished',
        fields: {
          harness: 'claude',
          runId: 'run-1',
          stepId: 'fix',
          ok: true,
          exitCode: 0,
          durationMs: expect.any(Number),
          costUsd: 0.12,
        },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(context().step.instruction);
  });
});

describe('createExecutors', () => {
  test('simulate mode never starts a real session, whatever the harness', async () => {
    const bin = stubBinary('claude', { stdout: CLAUDE_OK });
    const executors = createExecutors(
      makeConfig({ SWITCHYARD_CLAUDE_BIN: bin, SWITCHYARD_CODEX_BIN: bin }),
      capturingLogger().log,
    );

    expect(Object.values(executors).map((executor) => executor.harness)).toEqual(['simulated', 'claude', 'codex']);
    await executors.claude.run(context(), new AbortController().signal);
    await executors.codex.run(context(), new AbortController().signal);
    expect(existsSync(join(temp.dir, 'pid.txt'))).toBe(false);
  });

  test('live mode backs Claude and Codex with command-line sessions', async () => {
    const bin = stubBinary('claude', { stdout: CLAUDE_OK });
    const executors = createExecutors(
      liveConfig({ SWITCHYARD_CLAUDE_BIN: bin, SWITCHYARD_CODEX_BIN: bin }),
      capturingLogger().log,
    );

    const result = await executors.claude.run(context(), new AbortController().signal);

    expect(executors.simulated.harness).toBe('simulated');
    expect(executors.codex.harness).toBe('codex');
    expect(result.costUsd).toBe(0.12);
    expect(existsSync(join(temp.dir, 'pid.txt'))).toBe(true);
  });
});
