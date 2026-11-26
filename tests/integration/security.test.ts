import { afterEach, describe, expect, test } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/shared/api.js';
import { SECURITY_HEADERS } from '../../src/server/http/security.js';
import { FakeTime } from '../unit/engine/support.js';
import type { SignalAdapter } from '../../src/server/ports.js';
import { call, peer, startServer, TOKEN } from './support.js';
import type { TestServer, TestServerOptions } from './support.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function boot(options: TestServerOptions = {}): Promise<TestServer> {
  server = await startServer(options);
  return server;
}

describe('security headers', () => {
  test('are sent with successes, refusals and unknown routes alike', async () => {
    const { app } = await boot();

    for (const path of ['/api/health', '/api/runs/run_404', '/api/nope', '/']) {
      const response = await app.request(path);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name), `${name} on ${path}`).toBe(value);
      }
    }
  });
});

describe('bearer token', () => {
  test('is required on every API route except health and webhooks', async () => {
    const { app } = await boot({ config: { token: TOKEN } });

    const missing = await call(app, '/api/overview');
    const wrong = await call(app, '/api/overview', { headers: { authorization: `Bearer ${TOKEN}x` } });
    const basic = await call(app, '/api/overview', { headers: { authorization: `Basic ${TOKEN}` } });
    const right = await call(app, '/api/overview', { headers: { authorization: `Bearer ${TOKEN}` } });
    const lowerCase = await call(app, '/api/overview', { headers: { authorization: `bearer ${TOKEN}` } });
    const health = await call(app, '/api/health');
    const hook = await call(app, '/api/hooks/github', { body: {} });

    expect([missing.status, wrong.status, basic.status]).toEqual([401, 401, 401]);
    expect(missing.envelope.error?.code).toBe('unauthorized');
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="switchyard"');
    expect([right.status, lowerCase.status, health.status]).toEqual([200, 200, 200]);
    expect(hook.status).toBe(404);
  });

  test('also guards writes and the event stream', async () => {
    const { app, container } = await boot({ config: { token: TOKEN } });

    const write = await call(app, '/api/signals/manual', { body: { title: 'x' } });
    const stream = await app.request('/api/stream');

    expect(write.status).toBe(401);
    expect(stream.status).toBe(401);
    expect(container.store.signals.count()).toBe(0);
  });

  test('lets a token holder use any host name', async () => {
    const { app } = await boot({ config: { token: TOKEN, host: '0.0.0.0', isLoopback: false } });

    const result = await call(app, '/api/overview', {
      headers: { host: 'switchyard.example:4310', authorization: `Bearer ${TOKEN}` },
    });

    expect(result.status).toBe(200);
  });
});

describe('without a token', () => {
  test('answers only requests addressed to a loopback name', async () => {
    const { app } = await boot();

    const allowed = ['127.0.0.1', '127.0.0.1:4310', 'localhost', 'LOCALHOST:5173', '[::1]', '[::1]:4310'];
    const refused = ['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '10.0.0.5:4310', '[::2]:4310', 'localhost:80:80'];
    for (const host of allowed) {
      expect((await call(app, '/api/overview', { headers: { host } })).status, host).toBe(200);
    }
    for (const host of refused) {
      const result = await call(app, '/api/overview', { headers: { host } });
      expect(result.status, host).toBe(403);
      expect(result.envelope.error?.code).toBe('forbidden');
    }
  });

  test('refuses a state-changing request from another origin', async () => {
    const { app, container } = await boot();
    const body = { paused: true };

    const foreign = await call(app, '/api/settings', { method: 'PUT', body, headers: { origin: 'http://evil.example' } });
    const opaque = await call(app, '/api/settings', { method: 'PUT', body, headers: { origin: 'null' } });
    const otherPort = await call(app, '/api/settings', {
      method: 'PUT',
      body,
      headers: { host: 'localhost:4310', origin: 'http://localhost:5173' },
    });
    const foreignRead = await call(app, '/api/settings', { headers: { origin: 'http://evil.example' } });

    expect([foreign.status, opaque.status, otherPort.status]).toEqual([403, 403, 403]);
    expect(foreignRead.status).toBe(200);
    expect(container.engine.settings().paused).toBe(false);
  });

  test('accepts writes from its own pages and from tools that send no origin', async () => {
    const { app } = await boot();

    const samePage = await call(app, '/api/settings', {
      method: 'PUT',
      body: { paused: true },
      headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' },
    });
    const curl = await call(app, '/api/settings', { method: 'PUT', body: { paused: false } });

    expect(samePage.status).toBe(200);
    expect(curl.status).toBe(200);
  });

  test('leaves webhooks to their signatures, whatever host they arrive under', async () => {
    const { app } = await boot();

    const result = await call(app, '/api/hooks/sentry', { body: {}, headers: { host: 'hooks.tunnel.example' } });

    expect(result.status).toBe(404);
    expect(result.envelope.error?.message).toBe('The sentry webhook is not configured on this server.');
  });
});

describe('request size', () => {
  test('refuses a body over the limit before reading it as JSON', async () => {
    const { app, container } = await boot();
    const huge = JSON.stringify({ title: 'x', payload: { blob: 'a'.repeat(MAX_BODY_BYTES) } });

    const streamed = await call(app, '/api/signals/manual', { raw: huge, headers: { 'content-type': 'application/json' } });
    const declared = await call(app, '/api/signals/manual', {
      raw: '{"title":"x"}',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
    });

    expect(streamed.status).toBe(413);
    expect(streamed.envelope.error?.code).toBe('payload_too_large');
    expect(declared.status).toBe(413);
    expect(container.store.signals.count()).toBe(0);
  });

  test('accepts a body just under the limit', async () => {
    const { app } = await boot();
    const filler = 'a'.repeat(MAX_BODY_BYTES - 200);

    const result = await call(app, '/api/signals/manual', { body: { title: 'x', payload: { filler } } });

    expect(result.status).toBe(200);
  });
});

describe('rate limits', () => {
  test('allows 240 API requests a minute per client, then asks it to wait', async () => {
    const time = new FakeTime();
    const { app } = await boot({ clock: time.clock });
    const env = peer('192.0.2.10');

    for (let i = 0; i < 240; i += 1) {
      expect((await call(app, '/api/health', { env })).status).toBe(200);
    }
    const limited = await call(app, '/api/health', { env });
    const neighbour = await call(app, '/api/health', { env: peer('192.0.2.11') });
    time.advance(Number(limited.headers.get('retry-after')) * 1_000);
    const later = await call(app, '/api/health', { env });

    expect(limited.status).toBe(429);
    expect(limited.envelope.error?.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(neighbour.status).toBe(200);
    expect(later.status).toBe(200);
  });

  test('are not used up by a flood of wrong tokens from the same address', async () => {
    const { app } = await boot({ config: { token: TOKEN } });
    const env = peer('198.51.100.20');

    const guesses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      guesses.push((await call(app, '/api/overview', { env, headers: { authorization: 'Bearer wrong' } })).status);
    }
    const real = await call(app, '/api/overview', { env, headers: { authorization: `Bearer ${TOKEN}` } });

    expect(guesses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(guesses.slice(30).every((status) => status === 429)).toBe(true);
    expect(real.status).toBe(200);
  });
});

describe('proxies and tunnels without a token', () => {
  const forwarded = [
    ['x-forwarded-for', '198.51.100.7'],
    ['x-forwarded-host', 'switchyard.example'],
    ['forwarded', 'for=198.51.100.7'],
    ['x-real-ip', '198.51.100.7'],
    ['cf-connecting-ip', '198.51.100.7'],
  ] as const;

  test.each(forwarded)('refuse a request carrying %s, even with a loopback Host', async (name, value) => {
    const { app, container } = await boot();

    const read = await call(app, '/api/overview', { headers: { host: '127.0.0.1:4310', [name]: value } });
    const write = await call(app, '/api/signals/manual', {
      body: { title: 'from the internet' },
      headers: { host: '127.0.0.1:4310', [name]: value },
    });

    expect([read.status, write.status]).toEqual([403, 403]);
    expect(read.envelope.error?.message).toContain('SWITCHYARD_TOKEN');
    expect(container.store.signals.count()).toBe(0);
  });

  test('allow a direct request, and allow proxy headers once a token is set', async () => {
    const direct = await boot();
    const plain = await call(direct.app, '/api/overview', { headers: { host: '127.0.0.1:4310' } });
    await direct.close();

    const { app } = await boot({ config: { token: TOKEN } });
    const proxied = await call(app, '/api/overview', {
      headers: { 'x-forwarded-for': '198.51.100.7', authorization: `Bearer ${TOKEN}` },
    });

    expect(plain.status).toBe(200);
    expect(proxied.status).toBe(200);
  });

  test('do not stop signed webhooks arriving through a tunnel', async () => {
    const adapters = { sentry: okAdapter('sentry'), github: okAdapter('github') };
    const { app } = await boot({ config: { githubSecret: 'github-webhook-secret' }, adapters });

    const delivery = await call(app, '/api/hooks/github', {
      body: { zen: 'ping' },
      headers: { 'x-forwarded-for': '140.82.112.3', host: 'switchyard.example' },
    });

    expect(delivery.status).toBe(200);
  });
});

/** An adapter that accepts every signature and ignores every delivery. */
function okAdapter(source: 'sentry' | 'github'): SignalAdapter {
  return { source, verify: () => true, normalise: () => null };
}

