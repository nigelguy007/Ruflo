import type { Context, Hono } from 'hono';
import type { SignalResult } from '../../shared/types.js';
import type { Engine } from '../engine/index.js';
import type { Logger, SignalAdapter } from '../ports.js';
import { fail, ok } from './envelope.js';

export type HookSource = 'sentry' | 'github';

export interface HookRouteDeps {
  engine: Engine;
  adapters: Readonly<Record<HookSource, SignalAdapter>>;
  /** null when the provider is not configured; its route then does not exist. */
  secrets: Readonly<Record<HookSource, string | null>>;
  log: Logger;
}

const IGNORED: SignalResult = { signal: null, runs: [], joined: [] };
const HOOK_SOURCES: readonly HookSource[] = ['sentry', 'github'];

function lowerCasedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * One delivery: the signature is checked over the exact raw body before the
 * body is parsed. Bodies and secrets are never logged.
 */
async function receive(c: Context, source: HookSource, deps: HookRouteDeps): Promise<Response> {
  const secret = deps.secrets[source];
  if (secret === null) return fail(c, 'not_found', `The ${source} webhook is not configured on this server.`);
  const adapter = deps.adapters[source];
  const raw = await c.req.text();
  const headers = lowerCasedHeaders(c.req.raw.headers);
  if (!adapter.verify(raw, headers, secret)) {
    deps.log.warn('webhook signature rejected', { source });
    return fail(c, 'unauthorized', `The ${source} signature does not match this server's secret.`);
  }
  const body = parseJson(raw);
  if (!body.ok) return fail(c, 'bad_request', 'The delivery body is not valid JSON.');
  const normalised = adapter.normalise(body.value, headers);
  if (normalised === null) return ok(c, IGNORED);
  const result = deps.engine.dispatch(normalised);
  deps.log.info('webhook accepted', {
    source,
    kind: normalised.kind,
    runs: result.runs.length,
    joined: result.joined.length,
  });
  return ok(c, result);
}

export function registerHookRoutes(app: Hono, deps: HookRouteDeps): void {
  for (const source of HOOK_SOURCES) {
    app.post(`/api/hooks/${source}`, (c) => receive(c, source, deps));
  }
}
