/** An error shaped like the one `fetch` and `timers/promises` reject with on abort. */
export function abortError(message: string = 'The operation was aborted'): Error {
  return new DOMException(message, 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Resolve after `ms`, or reject with an AbortError as soon as `abort` fires. */
export function delay(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abort.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      abort.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    abort.addEventListener('abort', onAbort, { once: true });
  });
}
