import { API } from '../../../shared/api';
import type { StreamEvent } from '../../../shared/types';
import { demandToken, getToken } from './auth';

/**
 * GET /api/stream read with fetch and a ReadableStream reader instead of
 * EventSource, because EventSource cannot send an Authorization header.
 */

export type StreamStatus = 'connecting' | 'open' | 'retrying' | 'unauthorized';

export interface SseMessage {
  event: string;
  data: string;
}

/** Which payload key each event type must carry. */
const PAYLOAD_KEY: Record<StreamEvent['type'], string> = {
  'run.updated': 'run',
  'timeline.appended': 'event',
  'decision.opened': 'decision',
  'decision.resolved': 'decision',
  'signal.received': 'signal',
  'settings.updated': 'settings',
};

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Incremental text/event-stream parser. Feed it decoded chunks in order. */
export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length > 0) onMessage({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
  };

  const readLine = (line: string): void => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return; // comment, used as a keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  return (chunk: string): void => {
    buffer += chunk;
    // A lone trailing CR may be the first half of a CRLF split across chunks.
    const heldCr = buffer.endsWith('\r') ? '\r' : '';
    const text = heldCr ? buffer.slice(0, -1) : buffer;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    buffer = (lines.pop() ?? '') + heldCr;
    for (const line of lines) readLine(line);
  };
}

function isEventType(value: unknown): value is StreamEvent['type'] {
  return typeof value === 'string' && Object.hasOwn(PAYLOAD_KEY, value);
}

/** Turns one SSE message into a StreamEvent, or null when it is not one we know. */
export function toStreamEvent(message: SseMessage): StreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const type = isEventType(record.type) ? record.type : message.event;
  if (!isEventType(type)) return null;
  const payload = record[PAYLOAD_KEY[type]];
  if (typeof payload !== 'object' || payload === null) return null;
  return { ...record, type } as StreamEvent;
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return exponential * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function pump(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const feed = createSseParser((message) => {
    const event = toStreamEvent(message);
    if (event) onEvent(event);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  onStatus: (status: StreamStatus) => void;
}

/** Opens the stream and keeps it open, reconnecting with backoff. Returns a close function. */
export function openStream(handlers: StreamHandlers): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!signal.aborted) {
      handlers.onStatus(attempt === 0 ? 'connecting' : 'retrying');
      try {
        const headers = new Headers({ Accept: 'text/event-stream' });
        const token = getToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const response = await fetch(API.stream, { headers, signal, cache: 'no-store' });
        if (response.status === 401) {
          demandToken();
          handlers.onStatus('unauthorized');
          return; // a new token restarts the stream
        }
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
        attempt = 0;
        handlers.onStatus('open');
        await pump(response.body, handlers.onEvent);
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      attempt += 1;
      handlers.onStatus('retrying');
      await sleep(retryDelay(attempt), signal);
    }
  };

  void run();
  return () => controller.abort();
}
