import { afterEach, describe, expect, test } from 'vitest';
import type { Decision, LedgerCheck, Overview, RunDetail, SignalResult } from '../../src/shared/types.js';
import { call, data, startServer } from './support.js';
import type { TestServer } from './support.js';

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function boot(): Promise<TestServer> {
  server = await startServer();
  return server;
}

describe('a manual error from signal to shipped fix', () => {
  test('runs to the gate, waits for a person, and finishes once approved', async () => {
    const { app, container, commands } = await boot();

    const started = await data<SignalResult>(app, '/api/signals/manual', {
      body: { title: 'Checkout page throws on an empty cart', kind: 'manual.error' },
    });
    await container.engine.whenIdle();

    expect(started.signal).toMatchObject({ source: 'manual', kind: 'manual.error', severity: 'warning' });
    expect(started.signal?.fingerprint).toMatch(/^manual:[0-9a-f]{16}$/);
    expect(started.runs.map((r) => [r.id, r.playbookId, r.status])).toEqual([['run_1', 'error-to-fix', 'queued']]);

    const waiting = await data<RunDetail>(app, '/api/runs/run_1');
    expect(waiting.run).toMatchObject({ status: 'waiting_gate', currentStepId: 'approve' });
    expect(waiting.signal.id).toBe(started.signal?.id);
    expect(waiting.decision).toMatchObject({ id: 'dec_1', status: 'open' });

    const open = await call<Decision[]>(app, '/api/decisions?status=open');
    expect(open.envelope.meta).toEqual({ total: 1, limit: 50 });
    const decision = open.envelope.data?.[0];
    expect(decision?.question).toBe('Merge this fix and deploy it to production?');
    // Every shipped operator is on the scripted harness, so in live mode too its claim is
    // labelled simulated: only the engine's own `npm test` is verified.
    expect(decision?.evidence.map((e) => [e.kind, e.label, e.ok])).toEqual([
      ['simulated', 'Regression test added', true],
      ['verified', 'Run the test suite', true],
    ]);

    const answered = await data<Decision>(app, '/api/decisions/dec_1', {
      body: { verdict: 'approve', note: 'Ship it.' },
    });
    await container.engine.whenIdle();

    expect(answered).toMatchObject({ status: 'approved', decidedBy: 'human', note: 'Ship it.' });
    const done = await data<RunDetail>(app, '/api/runs/run_1');
    expect(done.run.status).toBe('succeeded');
    expect(done.run.steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(done.timeline.some((e) => e.kind === 'gate_resolved' && e.actor === 'human')).toBe(true);
    expect(commands.calls.map((c) => c.argv.join(' '))).toEqual(['npm test', 'gh pr merge --squash']);

    const ledger = await data<LedgerCheck>(app, '/api/ledger/verify');
    expect(ledger).toEqual({ ok: true, checked: container.store.timeline.count(), brokenAt: null });
    expect(ledger.checked).toBeGreaterThan(10);

    const overview = await data<Overview>(app, '/api/overview');
    expect(overview).toMatchObject({ openDecisions: 0, activeRuns: 0, failedRuns: 0 });
    expect(overview.digest).toMatchObject({ succeeded: 1, decisionsMade: 1, handledWithoutYou: 0 });
  });

  test('keeps the ledger verifiable when a title SQLite cannot store as given comes in over the API', async () => {
    const { app, container } = await boot();

    for (const title of ['Checkout fails \ud83d', 'Cart total is\0NaN']) {
      await data(app, '/api/signals/manual', { body: { title, kind: 'manual.error' } });
    }
    await container.engine.whenIdle();

    const total = container.store.timeline.count();
    expect(await data<LedgerCheck>(app, '/api/ledger/verify')).toEqual({ ok: true, checked: total, brokenAt: null });
    container.store.db.prepare('UPDATE timeline SET text = ? WHERE seq = ?').run('rewritten', total);
    expect(await data<LedgerCheck>(app, '/api/ledger/verify')).toEqual({ ok: false, checked: total - 1, brokenAt: total });
    expect(container.store.runs.require('run_1').title).toBe('Checkout fails \ufffd');
  });

  test('refuses to decide the same question twice', async () => {
    const { app, container } = await boot();
    await data(app, '/api/signals/manual', { body: { title: 'Cart total is NaN', kind: 'manual.error' } });
    await container.engine.whenIdle();
    await data(app, '/api/decisions/dec_1', { body: { verdict: 'reject' } });

    const again = await call(app, '/api/decisions/dec_1', { body: { verdict: 'approve' } });

    expect(again.status).toBe(409);
    expect(again.envelope).toMatchObject({ success: false, data: null, error: { code: 'conflict' } });
    await container.engine.whenIdle();
    expect(container.store.runs.require('run_1').status).toBe('rejected');
  });

  test('folds a repeat report of the same title into the run already handling it', async () => {
    const { app, container } = await boot();
    const body = { title: 'Cart total is NaN', kind: 'manual.error' };
    await data(app, '/api/signals/manual', { body });
    await container.engine.whenIdle();

    const repeat = await data<SignalResult>(app, '/api/signals/manual', { body: { ...body, title: '  cart TOTAL is NaN ' } });

    expect(repeat.runs).toEqual([]);
    expect(repeat.joined).toEqual(['run_1']);
  });

  test('cancels a run that is waiting at its gate, and will not cancel it twice', async () => {
    const { app, container } = await boot();
    await data(app, '/api/signals/manual', { body: { title: 'Cart total is NaN', kind: 'manual.error' } });
    await container.engine.whenIdle();

    const cancelled = await call(app, '/api/runs/run_1/cancel', { method: 'POST' });
    const twice = await call(app, '/api/runs/run_1/cancel', { method: 'POST' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.envelope.data).toMatchObject({ id: 'run_1', status: 'cancelled' });
    expect(twice.status).toBe(409);
    expect(await data<Decision[]>(app, '/api/decisions?status=open')).toEqual([]);
  });
});
