import { afterEach, describe, expect, test } from 'vitest';
import type {
  Health,
  Operator,
  Playbook,
  Run,
  Schedule,
  Settings,
  Signal,
  SignalResult,
  Watch,
} from '../../src/shared/types.js';
import type { Logger } from '../../src/server/ports.js';
import { call, data, startServer } from './support.js';
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

function recordingLogger(): Logger & { lines: { level: string; message: string; fields: unknown }[] } {
  const lines: { level: string; message: string; fields: unknown }[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields });
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

describe('reads', () => {
  test('reports health without asking who is calling', async () => {
    const { app } = await boot({ config: { token: 'x'.repeat(32) } });

    const health = await data<Health>(app, '/api/health');

    expect(health).toEqual({ status: 'ok', version: '0.1.0', mode: 'live', paused: false, coordination: 'local' });
  });

  test('lists the catalog with its total', async () => {
    const { app } = await boot();

    const operators = await call<Operator[]>(app, '/api/operators');
    const playbooks = await call<Playbook[]>(app, '/api/playbooks');
    const watches = await call<Watch[]>(app, '/api/watches');
    const schedules = await call<Schedule[]>(app, '/api/schedules');

    expect(operators.envelope.data?.map((o) => [o.id, o.status])).toContainEqual(['inspector', 'idle']);
    const count = operators.envelope.data?.length;
    expect(operators.envelope.meta).toEqual({ total: count, limit: count });
    expect(watches.envelope.meta?.total).toBe(watches.envelope.data?.length);
    expect(playbooks.envelope.data?.map((p) => p.id)).toContain('error-to-fix');
    expect(watches.envelope.data?.map((w) => w.id)).toContain('manual-error');
    expect(schedules.envelope.data?.map((s) => s.id)).toEqual(['nightly-dependencies']);
  });

  test('pages signals and runs, newest first, with total and limit', async () => {
    const { app, container } = await boot();
    for (const title of ['First problem', 'Second problem', 'Third problem']) {
      await data(app, '/api/signals/manual', { body: { title, kind: 'manual.error' } });
    }
    await container.engine.whenIdle();

    const signals = await call<Signal[]>(app, '/api/signals?limit=2');
    const runs = await call<Run[]>(app, '/api/runs?status=waiting_gate,succeeded&limit=1');
    const none = await call<Run[]>(app, '/api/runs?status=failed');

    expect(signals.envelope.data?.map((s) => s.title)).toEqual(['Third problem', 'Second problem']);
    expect(signals.envelope.meta).toEqual({ total: 3, limit: 2 });
    expect(runs.envelope.data?.map((r) => r.id)).toEqual(['run_3']);
    expect(runs.envelope.meta).toEqual({ total: 3, limit: 1 });
    expect(none.envelope).toMatchObject({ success: true, data: [], meta: { total: 0, limit: 50 } });
  });

  test('rejects a query it cannot use', async () => {
    const { app } = await boot();

    for (const path of ['/api/runs?status=bogus', '/api/runs?limit=0', '/api/signals?limit=500', '/api/decisions?status=maybe']) {
      const result = await call(app, path);
      expect(result.status, path).toBe(400);
      expect(result.envelope.error?.code, path).toBe('bad_request');
    }
  });

  test('says a run that does not exist was not found', async () => {
    const { app } = await boot();

    const missing = await call(app, '/api/runs/run_404');
    const nonsense = await call(app, `/api/runs/${encodeURIComponent('../../etc/passwd')}`);

    expect(missing.status).toBe(404);
    expect(missing.envelope).toEqual({
      success: false,
      data: null,
      error: { code: 'not_found', message: 'Run run_404 does not exist.' },
    });
    expect(nonsense.status).toBe(404);
  });

  test('answers an unknown API route with a 404 envelope', async () => {
    const { app } = await boot();

    for (const [method, path] of [['GET', '/api/nothing-here'], ['DELETE', '/api/runs'], ['POST', '/api/overview']]) {
      const result = await call(app, path ?? '', { method: method ?? 'GET' });
      expect(result.status, `${method} ${path}`).toBe(404);
      expect(result.envelope.error?.code).toBe('not_found');
    }
  });
});

describe('writes', () => {
  test('validates a manual signal before anything is stored', async () => {
    const { app, container } = await boot();

    const notJson = await call(app, '/api/signals/manual', { raw: '{"title":', headers: { 'content-type': 'application/json' } });
    const noTitle = await call(app, '/api/signals/manual', { body: { kind: 'manual.error' } });
    const badUrl = await call(app, '/api/signals/manual', { body: { title: 'x', url: 'javascript:alert(1)' } });
    const unknownPlaybook = await call(app, '/api/signals/manual', { body: { title: 'x', playbookId: 'nope' } });

    expect([notJson.status, noTitle.status, badUrl.status, unknownPlaybook.status]).toEqual([400, 400, 400, 400]);
    expect(notJson.envelope.error?.message).toBe('The request body must be valid JSON.');
    expect(noTitle.envelope.error?.message).toContain('title');
    expect(unknownPlaybook.envelope.error?.message).toBe('Playbook "nope" does not exist.');
    expect(container.store.signals.count()).toBe(0);
  });

  test('starts a named playbook directly', async () => {
    const { app } = await boot();

    const result = await data<SignalResult>(app, '/api/signals/manual', {
      body: { title: 'Look at PR 12', playbookId: 'review-pull-request', severity: 'info', fingerprint: 'pr-12' },
    });

    expect(result.runs.map((r) => r.playbookId)).toEqual(['review-pull-request']);
    expect(result.signal).toMatchObject({ severity: 'info', fingerprint: 'pr-12', kind: 'manual.run' });
  });

  test('switches a watch off and on from the console', async () => {
    const { app } = await boot();

    const off = await data<Watch>(app, '/api/watches/manual-error', { method: 'PATCH', body: { enabled: false } });
    const ignored = await data<SignalResult>(app, '/api/signals/manual', { body: { title: 'x', kind: 'manual.error' } });
    const listed = await data<Watch[]>(app, '/api/watches');
    const missing = await call(app, '/api/watches/no-such-watch', { method: 'PATCH', body: { enabled: true } });
    const invalid = await call(app, '/api/watches/manual-error', { method: 'PATCH', body: { enabled: 'yes' } });

    expect(off.enabled).toBe(false);
    expect(ignored.runs).toEqual([]);
    expect(listed.find((w) => w.id === 'manual-error')?.enabled).toBe(false);
    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(400);
  });

  test('pauses and resumes everything', async () => {
    const { app } = await boot();

    const paused = await data<Settings>(app, '/api/settings', { method: 'PUT', body: { paused: true } });
    const health = await data<Health>(app, '/api/health');
    const read = await data<Settings>(app, '/api/settings');
    const resumed = await data<Settings>(app, '/api/settings', { method: 'PUT', body: { paused: false } });
    const invalid = await call(app, '/api/settings', { method: 'PUT', body: {} });

    expect(paused).toEqual({ paused: true, mode: 'live' });
    expect(health.paused).toBe(true);
    expect(read.paused).toBe(true);
    expect(resumed.paused).toBe(false);
    expect(invalid.status).toBe(400);
  });

  test('rejects a decision without a verdict', async () => {
    const { app } = await boot();

    const result = await call(app, '/api/decisions/dec_1', { body: { verdict: 'maybe' } });
    const unknown = await call(app, '/api/decisions/dec_404', { body: { verdict: 'approve' } });

    expect(result.status).toBe(400);
    expect(unknown.status).toBe(404);
  });
});

describe('failures', () => {
  test('hides the details of an unexpected error from the caller and logs them', async () => {
    const log = recordingLogger();
    const { app, container } = await boot({ log });
    container.engine.overview = () => {
      throw new Error('disk on fire at /var/lib/switchyard');
    };

    const result = await call(app, '/api/overview');

    expect(result.status).toBe(500);
    expect(result.envelope.error).toEqual({
      code: 'internal',
      message: 'Something went wrong on the server. The details are in the server log.',
    });
    expect(JSON.stringify(result.envelope)).not.toContain('disk on fire');
    expect(log.lines.find((l) => l.level === 'error')).toMatchObject({
      message: 'request failed',
      fields: { method: 'GET', path: '/api/overview', error: 'disk on fire at /var/lib/switchyard' },
    });
  });
});
