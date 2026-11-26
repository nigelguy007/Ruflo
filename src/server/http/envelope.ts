import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode } from '../../shared/api.js';
import type { ApiEnvelope } from '../../shared/types.js';

/** The HTTP status each contract error code is sent with. */
export const STATUS_OF: Readonly<Record<ErrorCode, ContentfulStatusCode>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  internal: 500,
};

export const GENERIC_INTERNAL_MESSAGE =
  'Something went wrong on the server. The details are in the server log.';

/** A refusal decided by the HTTP layer itself, as opposed to one the engine raised. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

type Meta = NonNullable<ApiEnvelope<unknown>['meta']>;

function send<T>(c: Context, envelope: ApiEnvelope<T>, status: ContentfulStatusCode): Response {
  return c.body(JSON.stringify(envelope), status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

export function ok<T>(c: Context, data: T, meta?: Meta): Response {
  const envelope: ApiEnvelope<T> = { success: true, data, error: null };
  return send(c, meta === undefined ? envelope : { ...envelope, meta }, 200);
}

/** The one wording for every "slow down" answer, with the wait the client should honour. */
export function rateLimited(c: Context, retryAfterSeconds: number): Response {
  return fail(c, 'rate_limited', 'Too many requests. Wait a moment, then try again.', {
    'Retry-After': String(retryAfterSeconds),
  });
}

export function fail(
  c: Context,
  code: ErrorCode,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return send(c, { success: false, data: null, error: { code, message } }, STATUS_OF[code]);
}
