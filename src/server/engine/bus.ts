import type { StreamEvent } from '../../shared/types.js';
import { errorMessage } from '../logger.js';
import type { Logger } from '../ports.js';

export type StreamListener = (event: StreamEvent) => void;

/** In-process fan-out of everything the console should hear about. */
export interface EventBus {
  publish(event: StreamEvent): void;
  /** Returns a function that removes the listener. */
  subscribe(listener: StreamListener): () => void;
  listenerCount(): number;
}

export function createEventBus(log: Logger): EventBus {
  const listeners = new Set<StreamListener>();
  return {
    publish(event) {
      // Copy first: a listener may unsubscribe while we iterate.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          // One broken subscriber must not stop the engine or the other subscribers.
          log.error('event listener failed', { type: event.type, error: errorMessage(error) });
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount() {
      return listeners.size;
    },
  };
}
