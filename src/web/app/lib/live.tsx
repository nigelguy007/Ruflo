import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { StreamEvent } from '../../../shared/types';
import { useAuthEpoch } from './auth';
import { openStream } from './stream';
import type { StreamStatus } from './stream';

/**
 * The live bus. One stream connection for the whole console; screens subscribe
 * to the events they care about and refetch. `resync` is our own event: it
 * means "we may have missed something, reload what you show".
 */
export type LiveEvent = StreamEvent | { type: 'resync' };

type EventListener = (event: LiveEvent) => void;

const POLL_WHILE_DOWN_MS = 20_000;

const eventListeners = new Set<EventListener>();
const statusListeners = new Set<() => void>();
let status: StreamStatus = 'connecting';

function publish(event: LiveEvent): void {
  for (const listener of eventListeners) listener(event);
}

function setStatus(next: StreamStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of statusListeners) listener();
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStatus, () => status);
}

/** Calls `handler` for every live event while the component is mounted. */
export function useLiveEvent(handler: EventListener): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener: EventListener = (event) => latest.current(event);
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }, []);
}

/** Mount once. Owns the stream for the lifetime of the console. */
export function LiveConnection(): null {
  const epoch = useAuthEpoch();

  useEffect(() => {
    let everOpened = false;
    let dropped = false;
    const close = openStream({
      onEvent: publish,
      onStatus: (next) => {
        if (next === 'open') {
          if (everOpened && dropped) publish({ type: 'resync' });
          everOpened = true;
          dropped = false;
        } else if (next === 'retrying') {
          dropped = true;
        }
        setStatus(next);
      },
    });
    // While the stream is down, fall back to slow polling so the board never goes stale.
    const poll = window.setInterval(() => {
      if (status === 'retrying') publish({ type: 'resync' });
    }, POLL_WHILE_DOWN_MS);
    return () => {
      window.clearInterval(poll);
      close();
    };
  }, [epoch]);

  return null;
}
