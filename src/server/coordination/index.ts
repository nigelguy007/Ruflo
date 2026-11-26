import type { Config } from '../config.js';
import { errorMessage } from '../logger.js';
import type { Coordination, Logger } from '../ports.js';
import { LocalCoordination } from './local.js';
import { RufloCoordination } from './ruflo.js';
import { DEFAULT_RUFLO_COMMAND, connectRuflo, removeDataDir, rufloDataDir, rufloEnvironment } from './session.js';
import type { RufloCommand } from './session.js';

export { LocalCoordination } from './local.js';
export { RufloCoordination } from './ruflo.js';
export type { RufloCommand } from './session.js';

/** `auto` gives up after this and falls back to local memory; a cold `npx` can be slow. */
export const AUTO_CONNECT_TIMEOUT_MS = 30_000;
/** `ruflo` was asked for explicitly, so a first download of the package gets more time. */
export const RUFLO_CONNECT_TIMEOUT_MS = 120_000;

export interface CoordinationOptions {
  /** How to start the Ruflo MCP server; tests point this at a stub server. */
  command?: RufloCommand;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

async function startRuflo(
  config: Config,
  log: Logger,
  options: CoordinationOptions,
  defaultTimeoutMs: number,
): Promise<Coordination> {
  const dataDir = rufloDataDir(config.dbPath);
  const startedAt = Date.now();
  try {
    const session = await connectRuflo({
      command: options.command ?? DEFAULT_RUFLO_COMMAND,
      cwd: dataDir.path,
      env: rufloEnvironment(),
      timeoutMs: options.connectTimeoutMs ?? defaultTimeoutMs,
      log,
    });
    log.info('connected to Ruflo', {
      version: session.serverVersion,
      durationMs: Date.now() - startedAt,
      dataDir: dataDir.path,
    });
    return new RufloCoordination(session, log, {
      callTimeoutMs: options.callTimeoutMs,
      onClosed: () => removeDataDir(dataDir),
    });
  } catch (error) {
    removeDataDir(dataDir);
    throw error;
  }
}

/**
 * local: in-memory only. ruflo: connect to Ruflo or throw. auto: try Ruflo
 * within AUTO_CONNECT_TIMEOUT_MS, otherwise warn and use local memory.
 */
export async function createCoordination(
  config: Config,
  log: Logger,
  options: CoordinationOptions = {},
): Promise<Coordination> {
  if (config.coordination === 'local') return new LocalCoordination();
  if (config.coordination === 'ruflo') return startRuflo(config, log, options, RUFLO_CONNECT_TIMEOUT_MS);
  try {
    return await startRuflo(config, log, options, AUTO_CONNECT_TIMEOUT_MS);
  } catch (error) {
    log.warn('Ruflo is unavailable; using local memory instead', { error: errorMessage(error) });
    return new LocalCoordination();
  }
}
