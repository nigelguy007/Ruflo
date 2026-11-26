import { afterEach, describe, expect, test } from 'vitest';
import type { StreamEvent } from '../../src/shared/types.js';
import { createApp } from '../../src/server/http/index.js';
import type { AppDeps } from '../../src/server/http/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { signalAdapters } from '../../src/server/signals/index.js';
import { settle } from '../unit/engine/support.js';
import { data, startServer } from './support.js';
import type { TestServer } from './support.js';

const WAIT_MS = 2_000;

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function boot(): Promise<TestServer> {
  server = await startServer();
  return server;
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** Reads the stream until `text` shows up, and returns everything read so far. */
async function readUntil(reader: Reader, text: string): Promise<string> {
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + WAIT_MS;
  while (!seen.includes(text)) {
    if (Date.now() > deadline) throw new Error(`stream never sent ${JSON.stringify(text)}; got ${JSON.stringify(seen)}`);
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before ${JSON.stringify(text)}; got ${JSON.stringify(seen)}`);
    seen += decoder.decode(value, { stream: true });
  }
  return seen;
}

function eventsIn(text: string): StreamEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data: ')) ?? '';
      return JSON.parse(line.slice('data: '.length)) as StreamEvent;
    });
}

function appWith(target: TestServer, extra: Partial<AppDeps>): ReturnType<typeof createApp> {
  return createApp({
    config: target.config,
    engine: target.container.engine,
    bus: target.container.bus,
    adapters: signalAdapters,
    coordination: 'local',
    version: 'test',
    log: silentLogger,
    ...extra,
  });
}

describe('event stream', () => {
  test('sends each event as it happens, then lets go when the client leaves', async () => {
    const target = await boot();
    const { app, container } = target;
    const before = container.bus.listenerCount();

    const response = await app.request('/api/stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    await readUntil(reader, ': connected');
    const subscribed = container.bus.listenerCount();
    await data(app, '/api/settings', { method: 'PUT', body: { paused: true } });
    const text = await readUntil(reader, 'event: settings.updated');
    await reader.cancel();
    await settle();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(eventsIn(text)).toEqual([{ type: 'settings.updated', settings: { paused: true, mode: 'live' } }]);
    expect(subscribed).toBe(before + 1);
    expect(container.bus.listenerCount()).toBe(before);
  });

  test('carries a run from its first update to the open decision', async () => {
    const { app, container } = await boot();
    const response = await app.request('/api/stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    await readUntil(reader, ': connected');

    await data(app, '/api/signals/manual', { body: { title: 'Cart total is NaN', kind: 'manual.error' } });
    await container.engine.whenIdle();
    const text = await readUntil(reader, 'event: decision.opened');
    await reader.cancel();

    const types = eventsIn(text).map((e) => e.type);
    expect(types[0]).toBe('signal.received');
    expect(types).toContain('run.updated');
    expect(types).toContain('timeline.appended');
    expect(types.at(-1)).toBe('decision.opened');
  });

  test('sends a comment as a heartbeat', async () => {
    const target = await boot();
    const app = appWith(target, { streamHeartbeatMs: 10 });

    const response = await app.request('/api/stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    const text = await readUntil(reader, ': heartbeat');
    await reader.cancel();

    expect(text.startsWith(': connected\n\n')).toBe(true);
  });

  test('refuses more streams than it is willing to hold open', async () => {
    const target = await boot();
    const app = appWith(target, { maxStreams: 1 });

    const first = await app.request('/api/stream');
    const second = await app.request('/api/stream');
    const reader = first.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await settle();
    const third = await app.request('/api/stream');
    await third.body?.cancel();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(third.status).toBe(200);
  });
});
