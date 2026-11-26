import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Environment } from './environment.js';
import { TailBuffer } from './tail-buffer.js';

/**
 * One child process, run without a shell, that always comes back: it resolves
 * with what happened instead of rejecting, kills the child on timeout or abort
 * (SIGTERM, then SIGKILL after a grace period) and bounds captured output.
 */

export const DEFAULT_KILL_GRACE_MS = 2_000;
/** How long to wait for the pipes to close after SIGKILL before giving up on them. */
const FORCE_SETTLE_MS = 1_000;
const IS_POSIX = process.platform !== 'win32';

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Environment;
  /** Written to stdin, which is then closed. null gives the child no stdin at all. */
  input: string | null;
  abort: AbortSignal;
  /** 0 means no timeout. */
  timeoutMs: number;
  /** merged: stderr is interleaved into `stdout` in arrival order, as a terminal shows it. */
  capture: 'merged' | 'separate';
  maxStdoutBytes: number;
  maxStderrBytes: number;
  killGraceMs?: number;
}

export interface ProcessOutcome {
  /** null when the child was killed by a signal or never started. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the child could not be started, e.g. the binary does not exist. */
  spawnError: string | null;
}

type StopReason = 'aborted' | 'timedOut';

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** If the server exits while a child is still running, take the child's process group with it. */
function track(child: ChildProcess): void {
  liveChildren.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const live of liveChildren) signalTree(live, 'SIGKILL');
  });
}

/** Signal the child's whole process group so grandchildren (npm → node) die with it. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (IS_POSIX && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

function emptyOutcome(overrides: Partial<ProcessOutcome>): ProcessOutcome {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    timedOut: false,
    aborted: false,
    spawnError: null,
    ...overrides,
  };
}

/** Watches one running child and resolves exactly once with its outcome. */
class Supervisor {
  private readonly stdout: TailBuffer;
  private readonly stderr: TailBuffer;
  private readonly timers: NodeJS.Timeout[] = [];
  private stopReason: StopReason | null = null;
  private spawnError: string | null = null;
  private settled = false;
  private readonly onAbort = (): void => this.stop('aborted');

  constructor(
    private readonly child: ChildProcess,
    private readonly request: ProcessRequest,
    private readonly resolve: (outcome: ProcessOutcome) => void,
  ) {
    this.stdout = new TailBuffer(request.maxStdoutBytes);
    this.stderr = request.capture === 'merged' ? this.stdout : new TailBuffer(request.maxStderrBytes);
  }

  watch(): void {
    const { child, request } = this;
    track(child);
    child.stdout?.on('data', (chunk: Buffer) => this.stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    child.on('error', (error) => {
      // Without a pid the child never started, and 'close' may never fire.
      if (child.pid !== undefined) return;
      this.spawnError = error.message;
      this.settle(null, null);
    });
    child.on('close', (code, signal) => this.settle(code, signal));

    request.abort.addEventListener('abort', this.onAbort, { once: true });
    if (request.timeoutMs > 0) {
      this.timers.push(setTimeout(() => this.stop('timedOut'), request.timeoutMs));
    }
    if (child.stdin) {
      // A child that exits without reading its input must not crash the server with EPIPE.
      child.stdin.on('error', () => undefined);
      child.stdin.end(request.input ?? '');
    }
  }

  private stop(reason: StopReason): void {
    if (this.settled || this.stopReason !== null) return;
    this.stopReason = reason;
    signalTree(this.child, 'SIGTERM');
    const grace = this.request.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.timers.push(setTimeout(() => this.forceKill(), grace));
  }

  private forceKill(): void {
    signalTree(this.child, 'SIGKILL');
    // A grandchild that escaped the group can hold the pipes open; do not wait for it.
    const giveUp = (): void => this.settle(this.child.exitCode, this.child.signalCode ?? 'SIGKILL');
    this.timers.push(setTimeout(giveUp, FORCE_SETTLE_MS));
  }

  private settle(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.timers.forEach(clearTimeout);
    this.request.abort.removeEventListener('abort', this.onAbort);
    liveChildren.delete(this.child);
    this.resolve({
      exitCode,
      signal,
      stdout: this.stdout.toString(),
      stderr: this.request.capture === 'merged' ? '' : this.stderr.toString(),
      stdoutTruncated: this.stdout.truncated,
      timedOut: this.stopReason === 'timedOut',
      aborted: this.stopReason === 'aborted',
      spawnError: this.spawnError,
    });
  }
}

export function runProcess(request: ProcessRequest): Promise<ProcessOutcome> {
  if (request.abort.aborted) return Promise.resolve(emptyOutcome({ aborted: true }));

  return new Promise((resolve) => {
    try {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        detached: IS_POSIX,
        windowsHide: true,
        stdio: [request.input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      new Supervisor(child, request, resolve).watch();
    } catch (error) {
      resolve(emptyOutcome({ spawnError: error instanceof Error ? error.message : String(error) }));
    }
  });
}
