import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_BODY_BYTES } from '../../shared/api.js';
import type { CoordinationKind } from '../../shared/types.js';
import type { Config } from '../config.js';
import type { EventBus } from '../engine/bus.js';
import { EngineError } from '../engine/index.js';
import type { Engine } from '../engine/index.js';
import { systemClock } from '../engine/time.js';
import type { Clock } from '../engine/time.js';
import { errorMessage } from '../logger.js';
import type { Logger, SignalAdapter } from '../ports.js';
import { registerApiRoutes } from './api-routes.js';
import { fail, GENERIC_INTERNAL_MESSAGE, HttpError } from './envelope.js';
import { registerHookRoutes } from './hooks.js';
import type { HookSource } from './hooks.js';
import { createRateLimiter } from './rate-limit.js';
import { bearerAuth, loopbackGuard, rateLimit, securityHeaders } from './security.js';
import { createStaticHandler } from './static.js';
import { DEFAULT_HEARTBEAT_MS, DEFAULT_MAX_STREAMS, registerStreamRoute } from './stream.js';

export const API_REQUESTS_PER_MINUTE = 240;
export const HOOK_REQUESTS_PER_MINUTE = 60;
const MAX_LOGGED_PATH = 200;

export interface AppDeps {
  config: Config;
  engine: Engine;
  bus: EventBus;
  adapters: Readonly<Record<HookSource, SignalAdapter>>;
  coordination: CoordinationKind;
  version: string;
  log: Logger;
  /** Drives the rate limiter; defaults to the system clock. */
  clock?: Clock;
  streamHeartbeatMs?: number;
  maxStreams?: number;
}

function installGuards(app: Hono, deps: AppDeps): void {
  const now = (): number => (deps.clock ?? systemClock)().getTime();
  app.use('*', securityHeaders());
  if (deps.config.token === null) app.use('*', loopbackGuard());
  app.use(
    '/api/*',
    rateLimit(
      createRateLimiter({ perMinute: API_REQUESTS_PER_MINUTE, now }),
      createRateLimiter({ perMinute: HOOK_REQUESTS_PER_MINUTE, now }),
    ),
  );
  if (deps.config.token !== null) app.use('/api/*', bearerAuth(deps.config.token));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        fail(c, 'payload_too_large', `Request bodies are limited to ${MAX_BODY_BYTES / 1024} KiB.`),
    }),
  );
}

function unknownRoute(method: string, path: string): string {
  return `This API has no ${method} ${path.slice(0, MAX_LOGGED_PATH)}.`;
}

function installFallbacks(app: Hono, deps: AppDeps): void {
  app.all('/api/*', (c) => fail(c, 'not_found', unknownRoute(c.req.method, c.req.path)));
  app.get('*', createStaticHandler(deps.config.webDir));
  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? fail(c, 'not_found', unknownRoute(c.req.method, c.req.path))
      : c.text('Not found\n', 404),
  );
  app.onError((error, c) => {
    if (error instanceof EngineError) return fail(c, error.code, error.message);
    if (error instanceof HttpError) return fail(c, error.code, error.message, error.headers);
    deps.log.error('request failed', {
      method: c.req.method,
      path: c.req.path.slice(0, MAX_LOGGED_PATH),
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return fail(c, 'internal', GENERIC_INTERNAL_MESSAGE);
  });
}

/** The whole HTTP surface of src/shared/api.ts, plus the built console. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  installGuards(app, deps);
  registerApiRoutes(app, {
    engine: deps.engine,
    mode: deps.config.mode,
    coordination: deps.coordination,
    version: deps.version,
  });
  registerHookRoutes(app, {
    engine: deps.engine,
    adapters: deps.adapters,
    secrets: { sentry: deps.config.sentrySecret, github: deps.config.githubSecret },
    log: deps.log,
  });
  registerStreamRoute(app, {
    bus: deps.bus,
    heartbeatMs: deps.streamHeartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    maxStreams: deps.maxStreams ?? DEFAULT_MAX_STREAMS,
  });
  installFallbacks(app, deps);
  return app;
}

export { HttpError } from './envelope.js';
export type { HookSource } from './hooks.js';
