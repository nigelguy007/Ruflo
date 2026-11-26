import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Hono } from 'hono';
import type { ApiEnvelope, Harness } from '../../src/shared/types.js';
import type { Config } from '../../src/server/config.js';
import { createContainer } from '../../src/server/container.js';
import type { Container } from '../../src/server/container.js';
import type { HookSource } from '../../src/server/http/index.js';
import { silentLogger } from '../../src/server/logger.js';
import type { Clock } from '../../src/server/engine/time.js';
import type { Logger, SignalAdapter } from '../../src/server/ports.js';
import {
  fakeCommandRunner,
  fakeCoordination,
  fakeExecutor,
  makeConfig,
  okResult,
  sequentialIds,
} from '../unit/engine/support.js';
import type { FakeCommandRunner, FakeCoordination, FakeExecutor } from '../unit/engine/support.js';

/** The configuration that ships with the repository. */
export const CONFIG_DIR = resolve(import.meta.dirname, '../../config');
export const TOKEN = 'integration-test-token-0123456789abcdef';

export interface TestServer {
  container: Container;
  app: Hono;
  config: Config;
  executors: Record<Harness, FakeExecutor>;
  commands: FakeCommandRunner;
  coordination: FakeCoordination;
  close(): Promise<void>;
}

export interface TestServerOptions {
  config?: Partial<Config>;
  adapters?: Record<HookSource, SignalAdapter>;
  log?: Logger;
  clock?: Clock;
}

/** Operators "work" instantly; the fix step claims a regression test, the way a real session reports one. */
function scriptedExecutors(): Record<Harness, FakeExecutor> {
  const script: FakeExecutor['script'] = (ctx) =>
    okResult(`${ctx.operator.name} finished "${ctx.step.title}".`, {
      claims:
        ctx.step.id === 'fix'
          ? [{ label: 'Regression test added', detail: 'cart.test.ts fails without the fix.', ok: true }]
          : [],
    });
  return {
    simulated: fakeExecutor('simulated', script),
    claude: fakeExecutor('claude', script),
    codex: fakeExecutor('codex', script),
  };
}

export async function startServer(options: TestServerOptions = {}): Promise<TestServer> {
  const config = makeConfig({ configDir: CONFIG_DIR, ...options.config });
  const executors = scriptedExecutors();
  const commands = fakeCommandRunner();
  const coordination = fakeCoordination();
  const container = await createContainer(config, {
    executors,
    commandRunner: commands,
    coordination,
    log: options.log ?? silentLogger,
    newId: sequentialIds(),
    ...(options.adapters === undefined ? {} : { signalAdapters: options.adapters }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    container,
    app: container.app,
    config,
    executors,
    commands,
    coordination,
    close: () => container.close(),
  };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  /** Sent as is, without JSON encoding. */
  raw?: string;
  headers?: Record<string, string>;
  /** Stands in for the Node server's bindings, e.g. the peer address. */
  env?: Record<string, unknown>;
}

export interface CallResult<T> {
  status: number;
  headers: Headers;
  envelope: ApiEnvelope<T>;
}

export function peer(address: string): Record<string, unknown> {
  return { incoming: { socket: { remoteAddress: address } } };
}

export async function call<T = unknown>(app: Hono, path: string, options: CallOptions = {}): Promise<CallResult<T>> {
  const headers: Record<string, string> = { ...options.headers };
  let body: string | undefined = options.raw;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  }
  const init: RequestInit = { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers };
  if (body !== undefined) init.body = body;
  const response = await app.request(path, init, options.env);
  const envelope = (await response.json()) as ApiEnvelope<T>;
  return { status: response.status, headers: response.headers, envelope };
}

/** The data of a successful call; fails the test with the server's own words otherwise. */
export async function data<T>(app: Hono, path: string, options: CallOptions = {}): Promise<T> {
  const result = await call<T>(app, path, options);
  if (!result.envelope.success || result.envelope.data === null) {
    throw new Error(`${path} answered ${result.status}: ${JSON.stringify(result.envelope.error)}`);
  }
  return result.envelope.data;
}

/** A throwaway web directory laid out the way `vite build` leaves dist/web. */
export function makeWebDir(): { root: string; webDir: string; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), 'switchyard-web-'));
  const webDir = join(root, 'web');
  const files: Record<string, string> = {
    'index.html': '<!doctype html><title>landing</title>',
    'app/index.html': '<!doctype html><title>console</title>',
    'assets/app-3f9a1c.js': 'export const answer = 42;',
    'assets/app-3f9a1c.css': 'body { margin: 0; }',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(webDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(join(root, 'package.json'), '{"secret": "outside the web directory"}');
  return { root, webDir, remove: () => rmSync(root, { recursive: true, force: true }) };
}
