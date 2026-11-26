import type { Logger } from './ports.js';

type Level = 'info' | 'warn' | 'error';

/** One JSON object per line on stderr. Never log secrets, tokens or raw webhook bodies. */
export function createLogger(scope: string, sink: (line: string) => void = writeStderr): Logger {
  const emit = (level: Level, message: string, fields?: Record<string, unknown>): void => {
    sink(JSON.stringify({ at: new Date().toISOString(), level, scope, message, ...fields }));
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** A logger that drops everything; for tests. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
