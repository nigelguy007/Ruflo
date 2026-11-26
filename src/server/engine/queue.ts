import type { Id } from '../../shared/types.js';
import { errorMessage } from '../logger.js';
import type { Logger } from '../ports.js';

export interface RunQueue {
  /** Schedules work for a run. A run that is already being worked on is picked up again afterwards. */
  enqueue(runId: Id): void;
  /** Resolves once nothing is running or waiting. */
  whenIdle(): Promise<void>;
  /** Stops handing out new work; work already started is left to finish. */
  close(): void;
}

/** A small in-process work queue: at most `concurrency` runs are advanced at a time. */
export function createRunQueue(
  concurrency: number,
  work: (runId: Id) => Promise<void>,
  log: Logger,
): RunQueue {
  const waiting: Id[] = [];
  const active = new Set<Id>();
  const again = new Set<Id>();
  let idleWaiters: (() => void)[] = [];
  let closed = false;

  function settle(): void {
    if (active.size > 0 || (waiting.length > 0 && !closed)) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function finish(runId: Id): void {
    active.delete(runId);
    if (again.delete(runId)) waiting.push(runId);
    pump();
    settle();
  }

  function pump(): void {
    while (!closed && active.size < concurrency) {
      const runId = waiting.shift();
      if (runId === undefined) return;
      active.add(runId);
      // Start in a microtask so the caller that enqueued the run finishes its own work first.
      Promise.resolve()
        .then(() => work(runId))
        .catch((error: unknown) => {
          log.error('run worker crashed', { runId, error: errorMessage(error) });
        })
        .finally(() => finish(runId));
    }
  }

  return {
    enqueue(runId) {
      if (closed) return;
      if (active.has(runId)) {
        again.add(runId);
        return;
      }
      if (!waiting.includes(runId)) waiting.push(runId);
      pump();
    },
    whenIdle() {
      if (active.size === 0 && (waiting.length === 0 || closed)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    close() {
      closed = true;
      settle();
    },
  };
}
