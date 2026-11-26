/** Failures a caller can cause and should be told about; the HTTP layer maps `code` to a status. */
export type EngineErrorCode = 'not_found' | 'conflict' | 'bad_request';

export class EngineError extends Error {
  override readonly name = 'EngineError';

  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The reason an in-flight step is aborted when its run is cancelled. */
export class RunCancelledError extends Error {
  override readonly name = 'AbortError';

  constructor() {
    super('The run was cancelled.');
  }
}

/** The reason in-flight steps are aborted when the server stops; recovery reruns them at the next boot. */
export class ShutdownError extends Error {
  override readonly name = 'AbortError';

  constructor() {
    super('Switchyard is shutting down.');
  }
}

/** The reason an in-flight step is aborted when it runs out of time. */
export class StepTimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(readonly seconds: number) {
    super(`timed out after ${seconds} seconds`);
  }
}
