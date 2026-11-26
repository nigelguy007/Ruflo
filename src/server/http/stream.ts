import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import type { EventBus } from '../engine/bus.js';
import { fail } from './envelope.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
/** One console tab holds one stream; this is plenty for a self-hosted control room. */
export const DEFAULT_MAX_STREAMS = 50;
/** A client this far behind is not reading; it is cut off and its browser reconnects. */
const MAX_PENDING_WRITES = 500;

export interface StreamDeps {
  bus: EventBus;
  heartbeatMs: number;
  maxStreams: number;
}

/**
 * Forwards every bus event to one client until it goes away. Writes are
 * chained so events arrive in the order they were published, and a client
 * that stops reading is dropped instead of buffering without end.
 */
async function follow(stream: SSEStreamingApi, deps: StreamDeps): Promise<void> {
  const gone = new Promise<void>((resolve) => stream.onAbort(resolve));
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  const send = (write: () => Promise<unknown>): void => {
    if (stream.aborted || stream.closed) return;
    if (pending >= MAX_PENDING_WRITES) {
      stream.abort();
      return;
    }
    pending += 1;
    const settle = (): void => {
      pending -= 1;
    };
    chain = chain.then(write).then(settle, settle);
  };
  send(() => stream.write(': connected\n\n'));
  const unsubscribe = deps.bus.subscribe((event) =>
    send(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })),
  );
  const heartbeat = setInterval(() => send(() => stream.write(': heartbeat\n\n')), deps.heartbeatMs);
  heartbeat.unref();
  try {
    await gone;
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
  }
}

export function registerStreamRoute(app: Hono, deps: StreamDeps): void {
  let open = 0;
  app.get('/api/stream', (c) => {
    if (open >= deps.maxStreams) {
      return fail(c, 'rate_limited', 'Too many event streams are open. Close a console tab and try again.', {
        'Retry-After': '5',
      });
    }
    open += 1;
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      try {
        await follow(stream, deps);
      } finally {
        open -= 1;
      }
    });
  });
}
