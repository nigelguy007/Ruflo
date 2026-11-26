import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import type { Config } from './config.js';
import { createContainer, VERSION } from './container.js';
import type { Container } from './container.js';
import { createLogger, errorMessage } from './logger.js';

/** A shutdown that hangs this long is abandoned and the process exits anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

const log = createLogger('switchyard');

function exitWith(message: string): never {
  process.stderr.write(`Switchyard could not start: ${message}\n`);
  process.exit(1);
}

function displayUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function listen(container: Container, config: Config): ServerType {
  const server = serve({ fetch: container.app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info('Switchyard is listening', {
      url: displayUrl(config.host, info.port),
      version: VERSION,
      mode: config.mode,
      auth: config.token === null ? 'loopback only' : 'bearer token',
    });
  });
  // A port already in use, or one the process may not bind, arrives as an event rather than a throw.
  server.once('error', (error: unknown) => exitWith(`cannot listen on ${config.host}:${config.port} (${errorMessage(error)})`));
  return server;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Open event streams would otherwise hold the server open until they end on their own.
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
}

function onShutdown(server: ServerType, container: Container): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    setTimeout(() => {
      log.error('shutdown took too long; exiting anyway', { graceMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    // No new requests first, so nothing reaches the store after it is closed.
    closeServer(server)
      .then(() => container.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error('shutdown failed', { error: errorMessage(error) });
        process.exit(1);
      });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

async function main(): Promise<void> {
  let config: Config;
  let container: Container;
  try {
    config = loadConfig();
    container = await createContainer(config, { log });
  } catch (error) {
    if (error instanceof ConfigError) exitWith(error.message);
    throw error;
  }
  container.engine.recover();
  container.scheduler.start();
  onShutdown(listen(container, config), container);
}

main().catch((error: unknown) => exitWith(errorMessage(error)));
