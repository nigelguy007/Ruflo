import type { Harness } from '../../shared/types.js';
import type { Config } from '../config.js';
import type { Executor, Logger, StepContext, StepResult } from '../ports.js';
import { abortError } from './abort.js';
import { inheritedEnvironment } from './environment.js';
import { readClaudeOutput, readPlainOutput, toStepResult } from './parse.js';
import type { SessionText } from './parse.js';
import { runProcess } from './process.js';
import { buildPrompt } from './prompt.js';

/**
 * Runs one agent step as a non-interactive command-line session. The prompt
 * goes in on stdin, so it never appears in the process list, and the binary is
 * spawned from an argv array in the step's working directory, never via a shell.
 */

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface CliProfile {
  harness: Exclude<Harness, 'simulated'>;
  /** Name used in summaries and errors. */
  label: string;
  bin: string;
  /** Name of the setting that chooses `bin`, for the "could not start" message. */
  binSetting: string;
  args: readonly string[];
  readOutput: (stdout: string) => SessionText;
}

export interface CliExecutorOptions {
  killGraceMs?: number;
}

/**
 * Claude Code print mode. Flags confirmed against `claude --help` (2.1.332):
 * `-p` runs non-interactively and reads piped stdin, `--output-format json`
 * prints one result object, and `acceptEdits` lets the session edit files in
 * its working directory while every other permission still follows the
 * owner's Claude settings. Permissions are never bypassed.
 */
export function claudeProfile(config: Config): CliProfile {
  return {
    harness: 'claude',
    label: 'Claude',
    bin: config.claudeBin,
    binSetting: 'SWITCHYARD_CLAUDE_BIN',
    args: [
      '-p',
      'Your complete brief for this task was supplied on standard input and is part of this message. Carry it out and finish with the JSON block it asks for.',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
    ],
    readOutput: readClaudeOutput,
  };
}

/**
 * Codex non-interactive mode, written against its documentation and not run
 * here: `codex exec -` reads the prompt from stdin, progress goes to stderr and
 * only the final message is printed to stdout. `workspace-write` replaces the
 * read-only default so the session can edit files in its working directory.
 */
export function codexProfile(config: Config): CliProfile {
  return {
    harness: 'codex',
    label: 'Codex',
    bin: config.codexBin,
    binSetting: 'SWITCHYARD_CODEX_BIN',
    args: ['exec', '--sandbox', 'workspace-write', '-'],
    readOutput: readPlainOutput,
  };
}

function failure(summary: string): StepResult {
  return { ok: false, summary, artifacts: [], claims: [] };
}

export function createCliExecutor(
  profile: CliProfile,
  log: Logger,
  options: CliExecutorOptions = {},
): Executor {
  const run = async (ctx: StepContext, abort: AbortSignal): Promise<StepResult> => {
    if (abort.aborted) throw abortError('The session was aborted before it started');
    if (ctx.workdir === null) {
      return failure(`No working directory was given, so the ${profile.label} session was not started.`);
    }

    const startedAt = Date.now();
    const outcome = await runProcess({
      command: profile.bin,
      args: profile.args,
      cwd: ctx.workdir,
      env: inheritedEnvironment(),
      input: buildPrompt(ctx),
      abort,
      timeoutMs: 0,
      capture: 'separate',
      maxStdoutBytes: MAX_STDOUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
      killGraceMs: options.killGraceMs,
    });
    if (outcome.aborted) throw abortError(`The ${profile.label} session was aborted and its process was killed`);

    const fields = { harness: profile.harness, runId: ctx.run.id, stepId: ctx.step.id };
    if (outcome.spawnError !== null) {
      log.error('agent session could not start', { ...fields, error: outcome.spawnError });
      return failure(
        `Could not start the ${profile.label} session: ${outcome.spawnError}. Check ${profile.binSetting}.`,
      );
    }

    const result = toStepResult(profile.readOutput(outcome.stdout), {
      label: profile.label,
      exitCode: outcome.exitCode,
      stderr: outcome.stderr,
    });
    log.info('agent session finished', {
      ...fields,
      ok: result.ok,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
      costUsd: result.costUsd ?? null,
    });
    return result;
  };
  return { harness: profile.harness, run };
}
