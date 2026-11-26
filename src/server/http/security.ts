import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { fail } from './envelope.js';
import type { RateLimiter } from './rate-limit.js';

/** Sent with every response, API or not. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

const HEALTH_PATH = '/api/health';
const HOOKS_PREFIX = '/api/hooks/';
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const HOST_PATTERN = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d{1,5}))?$/;
const BEARER_PATTERN = /^Bearer +(\S+) *$/i;

/** Webhook deliveries prove who sent them with an HMAC signature instead of a bearer token. */
export function isHookPath(path: string): boolean {
  return path.startsWith(HOOKS_PREFIX);
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  };
}

/** true for 127.0.0.1, localhost and [::1], with or without a port. */
export function isLoopbackHost(host: string): boolean {
  const match = HOST_PATTERN.exec(host.trim().toLowerCase());
  return match !== null && LOOPBACK_NAMES.has(match[1] ?? '');
}

function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

/** Compares scheme-normalised hosts, so "http://localhost" matches "localhost:80". */
export function isSameOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.host === new URL(`${url.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

/**
 * Without a token the server trusts only its own machine. A Host header that
 * is not a loopback name means DNS rebinding; a state-changing request from
 * another origin means cross-site request forgery. Both are refused.
 * Webhook routes are exempt: a tunnel forwards them under a public name, and
 * their signature already proves the sender.
 */
export function loopbackGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (isHookPath(c.req.path)) return next();
    const host = requestHost(c);
    if (!isLoopbackHost(host)) {
      return fail(
        c,
        'forbidden',
        'This server answers only requests addressed to 127.0.0.1, localhost or [::1]. Set SWITCHYARD_TOKEN to serve it under another name.',
      );
    }
    const origin = c.req.header('origin');
    if (!SAFE_METHODS.has(c.req.method) && origin !== undefined && !isSameOrigin(origin, host)) {
      return fail(c, 'forbidden', "Requests that change something must come from this server's own pages.");
    }
    return next();
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Equal-length digests, so the comparison takes the same time whatever was presented. */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Every /api route except health and the webhooks needs `Authorization: Bearer <token>`. */
export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === HEALTH_PATH || isHookPath(c.req.path)) return next();
    const presented = BEARER_PATTERN.exec(c.req.header('authorization') ?? '')?.[1];
    if (presented === undefined || !tokenMatches(presented, token)) {
      return fail(c, 'unauthorized', 'This server needs a valid access token (Authorization: Bearer <token>).', {
        'WWW-Authenticate': 'Bearer realm="switchyard"',
      });
    }
    return next();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The peer address the Node server saw. Forwarded-for headers are not trusted: anyone can send them. */
export function clientAddress(c: Context): string {
  const env: unknown = c.env;
  if (!isRecord(env) || !isRecord(env['incoming'])) return 'unknown';
  const socket = env['incoming']['socket'];
  const address = isRecord(socket) ? socket['remoteAddress'] : undefined;
  return typeof address === 'string' && address.length > 0 ? address : 'unknown';
}

/** Webhooks get their own, smaller budget so a noisy provider cannot starve the console. */
export function rateLimit(api: RateLimiter, hooks: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const limiter = isHookPath(c.req.path) ? hooks : api;
    const decision = limiter.take(clientAddress(c));
    if (!decision.allowed) {
      return fail(c, 'rate_limited', 'Too many requests. Wait a moment, then try again.', {
        'Retry-After': String(decision.retryAfterSeconds),
      });
    }
    return next();
  };
}
