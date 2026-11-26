import { afterEach, describe, expect, test } from 'vitest';
import type { SignalResult } from '../../src/shared/types.js';
import type { HookSource } from '../../src/server/http/index.js';
import type { NormalisedSignal, SignalAdapter } from '../../src/server/ports.js';
import { hmacSha256Hex } from '../../src/server/signals/hmac.js';
import { call, startServer, TOKEN } from './support.js';
import type { TestServer, TestServerOptions } from './support.js';

const SENTRY_SECRET = 'sentry-client-secret';
const GITHUB_SECRET = 'github-webhook-secret';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function boot(options: TestServerOptions = {}): Promise<TestServer> {
  server = await startServer(options);
  return server;
}

interface FakeAdapter extends SignalAdapter {
  accept: boolean;
  next: NormalisedSignal | null;
  seen: { raw: string; headers: Record<string, string> }[];
}

function fakeAdapter(source: HookSource): FakeAdapter {
  const adapter: FakeAdapter = {
    source,
    accept: true,
    next: null,
    seen: [],
    verify(raw, headers, secret) {
      adapter.seen.push({ raw, headers });
      return adapter.accept && secret.length > 0;
    },
    normalise: () => adapter.next,
  };
  return adapter;
}

function fakeAdapters(): Record<HookSource, FakeAdapter> {
  return { sentry: fakeAdapter('sentry'), github: fakeAdapter('github') };
}

const configured = { sentrySecret: SENTRY_SECRET, githubSecret: GITHUB_SECRET };

describe('webhooks', () => {
  test('do not exist until their secret is configured', async () => {
    const { app } = await boot();

    const sentry = await call(app, '/api/hooks/sentry', { body: {} });
    const github = await call(app, '/api/hooks/github', { body: {} });
    const unknown = await call(app, '/api/hooks/gitlab', { body: {} });

    expect([sentry.status, github.status, unknown.status]).toEqual([404, 404, 404]);
    expect(sentry.envelope.error?.code).toBe('not_found');
  });

  test('refuse a delivery whose signature does not match', async () => {
    const adapters = fakeAdapters();
    adapters.sentry.accept = false;
    const { app, container } = await boot({ config: configured, adapters });

    const result = await call(app, '/api/hooks/sentry', { raw: '{"action":"created"}', headers: { 'Sentry-Hook-Signature': 'abc' } });

    expect(result.status).toBe(401);
    expect(result.envelope.error?.code).toBe('unauthorized');
    expect(adapters.sentry.seen).toEqual([
      { raw: '{"action":"created"}', headers: expect.objectContaining({ 'sentry-hook-signature': 'abc' }) },
    ]);
    expect(container.store.signals.count()).toBe(0);
  });

  test('refuse a signed body that is not JSON', async () => {
    const { app } = await boot({ config: configured, adapters: fakeAdapters() });

    const result = await call(app, '/api/hooks/github', { raw: 'payload=%7B%7D' });

    expect(result.status).toBe(400);
    expect(result.envelope.error?.message).toBe('The delivery body is not valid JSON.');
  });

  test('acknowledge a valid delivery they have no use for', async () => {
    const { app, container } = await boot({ config: configured, adapters: fakeAdapters() });

    const result = await call<SignalResult>(app, '/api/hooks/github', { body: { zen: 'Keep it logically awesome.' } });

    expect(result.status).toBe(200);
    expect(result.envelope).toEqual({ success: true, data: { signal: null, runs: [], joined: [] }, error: null });
    expect(container.store.signals.count()).toBe(0);
  });

  test('start the runs a recognised delivery calls for', async () => {
    const adapters = fakeAdapters();
    adapters.sentry.next = {
      source: 'sentry',
      kind: 'issue.created',
      title: 'TypeError: cannot read properties of undefined',
      fingerprint: 'sentry:1234',
      url: 'https://sentry.example/issues/1234',
      severity: 'error',
      payload: { issueId: '1234' },
    };
    const { app } = await boot({ config: configured, adapters });

    const result = await call<SignalResult>(app, '/api/hooks/sentry', { body: { action: 'created' } });

    expect(result.status).toBe(200);
    expect(result.envelope.data?.signal).toMatchObject({ source: 'sentry', fingerprint: 'sentry:1234' });
    expect(result.envelope.data?.runs.map((r) => r.playbookId)).toEqual(['error-to-fix']);
  });

  test('need no bearer token, even when the rest of the API does', async () => {
    const { app } = await boot({ config: { ...configured, token: TOKEN }, adapters: fakeAdapters() });

    const result = await call(app, '/api/hooks/github', { body: {} });

    expect(result.status).toBe(200);
  });

  test('check the real GitHub signature over the exact raw body', async () => {
    const { app } = await boot({ config: configured });
    const raw = JSON.stringify({ zen: 'Design for failure.', hook_id: 1 });
    const headers = { 'X-GitHub-Event': 'ping', 'Content-Type': 'application/json' };

    const signed = await call(app, '/api/hooks/github', {
      raw,
      headers: { ...headers, 'X-Hub-Signature-256': `sha256=${hmacSha256Hex(GITHUB_SECRET, raw)}` },
    });
    const tampered = await call(app, '/api/hooks/github', {
      raw: raw.replace('failure', 'success'),
      headers: { ...headers, 'X-Hub-Signature-256': `sha256=${hmacSha256Hex(GITHUB_SECRET, raw)}` },
    });

    expect(signed.status).toBe(200);
    expect(signed.envelope.data).toEqual({ signal: null, runs: [], joined: [] });
    expect(tampered.status).toBe(401);
  });
});
