import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../src/server/config.js';
import type { Config } from '../../../src/server/config.js';
import type { Logger, StepContext } from '../../../src/server/ports.js';
import type { AgentStep, Operator, Run, Signal } from '../../../src/shared/types.js';

export const SIGNAL_TITLE = 'TypeError: cart.total is undefined';

export function makeOperator(overrides: Partial<Operator> = {}): Operator {
  return {
    id: 'fitter',
    name: 'Fitter',
    handle: '@fitter',
    role: 'Writes the smallest fix that works, with a regression test',
    instructions: 'Make one focused change on a new branch. Write a failing regression test first.',
    harness: 'simulated',
    status: 'working',
    currentRunId: 'run-1',
    currentActivity: null,
    ...overrides,
  };
}

export function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    source: 'sentry',
    kind: 'issue.created',
    title: SIGNAL_TITLE,
    fingerprint: 'sentry:1234567890',
    url: 'https://example-org.sentry.io/issues/1234567890/',
    severity: 'error',
    payload: { issueId: '1234567890', project: 'checkout', level: 'error' },
    receivedAt: '2026-11-26T12:00:00.000Z',
    ...overrides,
  };
}

export function makeStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: 'fix',
    kind: 'agent',
    title: 'Write the fix and a regression test',
    operator: 'fitter',
    instruction: 'Add a failing regression test, then the smallest fix that makes it pass.',
    ...overrides,
  };
}

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    playbookId: 'error-to-fix',
    playbookName: 'Production error to shipped fix',
    playbookVersion: 1,
    signalId: 'sig-1',
    title: SIGNAL_TITLE,
    status: 'running',
    createdAt: '2026-11-26T12:00:00.000Z',
    startedAt: '2026-11-26T12:00:01.000Z',
    finishedAt: null,
    currentStepId: 'fix',
    stopReason: null,
    duplicateSignals: 0,
    steps: [],
    ...overrides,
  };
}

export function makeContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    run: makeRun(),
    step: makeStep(),
    operator: makeOperator(),
    signal: makeSignal(),
    recalled: [],
    prior: [],
    workdir: null,
    ...overrides,
  };
}

export function makeConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ SWITCHYARD_STEP_DELAY_MS: '0', ...env });
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

export function capturingLogger(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry['level']) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields });
    };
  return { log: { info: record('info'), warn: record('warn'), error: record('error') }, entries };
}

/** A scratch directory that the returned `cleanup` removes again. */
export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'switchyard-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a small Node script that can be spawned directly, as a stand-in for a real CLI. */
export function writeExecutable(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${source}\n`);
  chmodSync(path, 0o755);
  return path;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}
