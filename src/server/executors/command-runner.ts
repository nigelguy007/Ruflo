import { constants as osConstants } from 'node:os';
import type { Config } from '../config.js';
import type { CommandOptions, CommandResult, CommandRunner, Logger } from '../ports.js';
import { abortError } from './abort.js';
import { minimalEnvironment } from './environment.js';
import { runProcess } from './process.js';
import type { ProcessOutcome } from './process.js';
import { utf8Tail } from './tail-buffer.js';

/** Combined stdout and stderr kept per command; the tail survives. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/** Used when a caller passes a timeout that is not a positive number. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

const EXIT_REFUSED = 126;
const EXIT_NOT_STARTED = 127;
const EXIT_TIMED_OUT = 124;
const SIGNAL_EXIT_BASE = 128;
const TRUNCATION_NOTE = '[earlier output dropped; showing the last 64 KB]\n';

export interface CommandRunnerOptions {
  killGraceMs?: number;
}

/** argv as a person would type it, for dry-run output and refusal messages. */
function display(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
}

/** Why this argv must not run, or null when it may. */
export function refusalReason(argv: readonly string[], allowed: readonly string[]): string | null {
  const binary = argv[0];
  if (typeof binary !== 'string' || binary.length === 0) return 'the command is empty';
  if (argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return 'an argument is not a plain string';
  }
  if (binary.includes('/') || binary.includes('\\')) {
    return `"${binary}" contains a path separator; commands are named, not located`;
  }
  if (!allowed.includes(binary)) {
    return `"${binary}" is not in SWITCHYARD_ALLOWED_COMMANDS (${allowed.join(', ') || 'empty'})`;
  }
  return null;
}

function refused(reason: string): CommandResult {
  return {
    exitCode: EXIT_REFUSED,
    output: `refused: ${reason}. Nothing was executed.`,
    dryRun: false,
    timedOut: false,
    executed: false,
  };
}

/** Output plus an optional closing note, cut from the front so the whole stays inside the limit. */
function boundedOutput(body: string, alreadyCut: boolean, note: string): string {
  const bytes = Buffer.from(body, 'utf8');
  const noteBytes = Buffer.byteLength(note);
  if (!alreadyCut && bytes.length + noteBytes <= MAX_OUTPUT_BYTES) return `${body}${note}`;
  const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTE) - noteBytes;
  return `${TRUNCATION_NOTE}${utf8Tail(bytes, budget).toString('utf8')}${note}`;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  const number = signal ? osConstants.signals[signal] : undefined;
  return SIGNAL_EXIT_BASE + (number ?? 0);
}

function toResult(outcome: ProcessOutcome, binary: string, timeoutMs: number): CommandResult {
  if (outcome.spawnError !== null) {
    return {
      exitCode: EXIT_NOT_STARTED,
      output: `could not start "${binary}": ${outcome.spawnError}`,
      dryRun: false,
      timedOut: false,
      executed: false,
    };
  }
  if (outcome.timedOut) {
    const note = `\n[timed out after ${Math.round(timeoutMs / 1000)}s; the command was killed]`;
    return {
      exitCode: EXIT_TIMED_OUT,
      output: boundedOutput(outcome.stdout, outcome.stdoutTruncated, note),
      dryRun: false,
      timedOut: true,
    };
  }
  return {
    exitCode: outcome.exitCode ?? signalExitCode(outcome.signal),
    output: boundedOutput(outcome.stdout, outcome.stdoutTruncated, ''),
    dryRun: false,
    timedOut: false,
  };
}

/** Simulate mode: describe what would run and execute nothing. */
export function createDryRunCommandRunner(config: Config): CommandRunner {
  return {
    run: async (argv) => {
      const reason = refusalReason(argv, config.allowedCommands);
      const warning = reason === null ? '' : ` (live mode would refuse it: ${reason})`;
      return {
        exitCode: 0,
        output: `dry run: would execute ${display(argv)}${warning}`,
        dryRun: true,
        timedOut: false,
      };
    },
  };
}

/** Live mode: run an allow-listed binary by name, without a shell, in a minimal environment. */
export function createLiveCommandRunner(
  config: Config,
  log: Logger,
  options: CommandRunnerOptions = {},
): CommandRunner {
  const run = async (argv: string[], opts: CommandOptions): Promise<CommandResult> => {
    const reason = refusalReason(argv, config.allowedCommands);
    if (reason !== null) {
      log.warn('command refused', { command: argv[0] ?? null, reason });
      return refused(reason);
    }
    if (opts.cwd === null) return refused('no working directory was given');
    if (opts.abort.aborted) throw abortError('The command was aborted before it started');

    const binary = argv[0] ?? '';
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const outcome = await runProcess({
      command: binary,
      args: argv.slice(1),
      cwd: opts.cwd,
      env: minimalEnvironment(),
      input: null,
      abort: opts.abort,
      timeoutMs,
      capture: 'merged',
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_OUTPUT_BYTES,
      killGraceMs: options.killGraceMs,
    });
    if (outcome.aborted) throw abortError('The command was aborted and its process was killed');

    const result = toResult(outcome, binary, timeoutMs);
    log.info('command finished', {
      command: binary,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };
  return { run };
}
