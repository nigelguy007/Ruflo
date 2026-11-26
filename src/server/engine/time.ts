import { randomUUID } from 'node:crypto';

/** Injected so tests control time, identity and waiting. */
export type Clock = () => Date;
export type IdGenerator = (prefix: string) => string;
/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const ID_LENGTH = 16;

export const systemClock: Clock = () => new Date();

export const randomId: IdGenerator = (prefix) =>
  `${prefix}_${randomUUID().replaceAll('-', '').slice(0, ID_LENGTH)}`;

export const timerSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    // A pending wait must never keep the process alive on its own.
    timer.unref();
    signal?.addEventListener('abort', finish, { once: true });
  });

export function iso(date: Date): string {
  return date.toISOString();
}

export const MINUTE_MS = 60_000;
