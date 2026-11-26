import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DISCONNECTED_REASON,
  RufloCoordination,
  namespaceFor,
} from '../../../src/server/coordination/ruflo.js';
import { capturingLogger } from '../executors/helpers.js';
import { FakeSession, never, textResult } from './support.js';

const QUERY = 'TypeError: cart.total is undefined';
const LONG_NOTE = `Production error to shipped fix for "${QUERY}" ended succeeded. Fix: guarded the null cart.`;

function preview(text: string): string {
  return `${text.slice(0, 60)}...`;
}

function searchAnswer(namespace: string): unknown {
  return textResult({
    query: QUERY,
    results: [
      { key: 'run:1', namespace, value: preview(LONG_NOTE), similarity: 0.86, provenanceType: 'agent_output' },
      { key: 'run:2', namespace, value: 'short note', similarity: 0.41, provenanceType: 'agent_output' },
    ],
    total: 2,
  });
}

function make(session: FakeSession, callTimeoutMs = 1_000): { memory: RufloCoordination; entries: ReturnType<typeof capturingLogger>['entries'] } {
  const { log, entries } = capturingLogger();
  return { memory: new RufloCoordination(session, log, { callTimeoutMs }), entries };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('namespaceFor', () => {
  test('gives each operator its own namespace in a form Ruflo accepts', () => {
    expect(namespaceFor('fitter')).toBe('switchyard:fitter');
    expect(namespaceFor('release-2.bot_1')).toBe('switchyard:release-2.bot_1');
  });

  test('refuses ids Ruflo would reject rather than rewriting them into a shared namespace', () => {
    expect(namespaceFor('team/fitter')).toBeNull();
    expect(namespaceFor('')).toBeNull();
    expect(namespaceFor('a'.repeat(101))).toBeNull();
  });
});

describe('RufloCoordination.recall', () => {
  test('searches the operator namespace and fetches the full text of shortened previews', async () => {
    const session = new FakeSession({
      memory_search: (args) => searchAnswer(String(args.namespace)),
      memory_retrieve: (args) => textResult({ key: args.key, value: LONG_NOTE, found: true }),
    });
    const { memory } = make(session);

    const hits = await memory.recall('fitter', QUERY, 3);

    expect(session.calls[0]?.args).toEqual({ query: QUERY, namespace: 'switchyard:fitter', limit: 3, threshold: 0.3 });
    expect(session.names()).toEqual(['memory_search', 'memory_retrieve']);
    expect(session.calls[1]?.args).toEqual({ key: 'run:1', namespace: 'switchyard:fitter' });
    expect(hits).toEqual([
      { key: 'run:1', text: LONG_NOTE, score: 0.86 },
      { key: 'run:2', text: 'short note', score: 0.41 },
    ]);
  });

  test('keeps the preview when the full text cannot be fetched', async () => {
    const session = new FakeSession({
      memory_search: (args) => searchAnswer(String(args.namespace)),
      memory_retrieve: () => textResult({ key: 'run:1', value: null, found: false }),
    });
    const failing = new FakeSession({
      memory_search: (args) => searchAnswer(String(args.namespace)),
      memory_retrieve: () => Promise.reject(new Error('gone')),
    });

    expect((await make(session).memory.recall('fitter', QUERY, 3))[0]?.text).toBe(preview(LONG_NOTE));
    expect((await make(failing).memory.recall('fitter', QUERY, 3))[0]?.text).toBe(preview(LONG_NOTE));
  });

  test('keeps the preview when the time budget is spent before the full text is fetched', async () => {
    vi.useFakeTimers();
    const session = new FakeSession({
      memory_search: (args) => {
        vi.setSystemTime(Date.now() + 10_000);
        return searchAnswer(String(args.namespace));
      },
      memory_retrieve: () => textResult({ value: LONG_NOTE, found: true }),
    });

    const hits = await make(session).memory.recall('fitter', QUERY, 3);

    expect(session.names()).toEqual(['memory_search']);
    expect(hits[0]?.text).toBe(preview(LONG_NOTE));
  });

  test('answers [] and warns, without the query, when the call fails', async () => {
    const answers: Record<string, () => unknown> = {
      rejected: () => Promise.reject(new Error('MCP error -32603: boom')),
      isError: () => ({ isError: true, content: [{ type: 'text', text: 'bad input' }] }),
      garbage: () => ({ content: [{ type: 'text', text: 'Stored!' }] }),
      wrongShape: () => textResult({ total: 0 }),
      throws: () => {
        throw new Error('synchronous failure');
      },
    };
    for (const [name, answer] of Object.entries(answers)) {
      const { memory, entries } = make(new FakeSession({ memory_search: answer }));
      expect(await memory.recall('fitter', QUERY, 3), name).toEqual([]);
      expect(entries.map((entry) => entry.message), name).toEqual(['Ruflo recall failed; continuing without memory']);
      expect(JSON.stringify(entries), name).not.toContain('cart.total');
    }
  });

  test('gives up after the call timeout and aborts the request', async () => {
    const session = new FakeSession({ memory_search: () => never() });
    const { memory, entries } = make(session, 50);
    const startedAt = Date.now();

    expect(await memory.recall('fitter', QUERY, 3)).toEqual([]);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(session.calls[0]?.signal.aborted).toBe(true);
    expect(entries[0]?.fields?.error).toBe('memory_search timed out after 50 ms');
  });

  test('sends nothing for an invalid operator id, a non-positive limit or a lost connection', async () => {
    const session = new FakeSession({ memory_search: (args) => searchAnswer(String(args.namespace)) });
    const { memory, entries } = make(session);

    expect(await memory.recall('team/fitter', QUERY, 3)).toEqual([]);
    expect(await memory.recall('fitter', QUERY, 0)).toEqual([]);
    expect(await memory.recall('fitter', QUERY, Number.NaN)).toEqual([]);
    session.connected = false;
    expect(await memory.recall('fitter', QUERY, 3)).toEqual([]);

    expect(session.calls).toEqual([]);
    expect(entries.map((entry) => entry.message)).toEqual([
      'Ruflo recall skipped: the operator id is not a valid namespace',
    ]);
  });

  test('asks for at most 20 notes', async () => {
    const session = new FakeSession({ memory_search: () => textResult({ results: [] }) });
    await make(session).memory.recall('fitter', QUERY, 500);
    expect(session.calls[0]?.args.limit).toBe(20);
  });
});

describe('RufloCoordination.remember', () => {
  test('stores the note in the operator namespace with the observed argument names', async () => {
    const session = new FakeSession({
      memory_store: (args) => textResult({ success: true, key: args.key, namespace: args.namespace, stored: true }),
    });
    const { memory, entries } = make(session);

    await memory.remember('fitter', 'run:1', LONG_NOTE, ['error-to-fix', 'succeeded']);

    expect(session.calls[0]).toMatchObject({
      name: 'memory_store',
      args: {
        key: 'run:1',
        value: LONG_NOTE,
        namespace: 'switchyard:fitter',
        tags: ['error-to-fix', 'succeeded'],
        upsert: true,
        provenance_type: 'agent_output',
      },
    });
    expect(entries).toEqual([]);
  });

  test('logs and swallows every failure, never the note itself', async () => {
    const answers: Record<string, () => unknown> = {
      rejected: () => Promise.reject(new Error('Not connected')),
      notStored: () => textResult({ success: true, stored: false }),
      refused: () => textResult({ success: false, error: 'value too large' }),
      hangs: () => never(),
    };
    for (const [name, answer] of Object.entries(answers)) {
      const { memory, entries } = make(new FakeSession({ memory_store: answer }), 50);
      await expect(memory.remember('fitter', 'run:1', LONG_NOTE, []), name).resolves.toBeUndefined();
      expect(entries.map((entry) => entry.message), name).toEqual(['Ruflo remember failed; the note was not stored']);
      expect(entries[0]?.fields).toMatchObject({ operatorId: 'fitter', key: 'run:1' });
      expect(JSON.stringify(entries), name).not.toContain('guarded the null cart');
    }
  });

  test('skips an invalid operator id and a lost connection', async () => {
    const session = new FakeSession({ memory_store: () => textResult({ success: true, stored: true }) });
    const { memory, entries } = make(session);

    await memory.remember('a b', 'run:1', 'note', []);
    session.connected = false;
    await memory.remember('fitter', 'run:1', 'note', []);

    expect(session.calls).toEqual([]);
    expect(entries.map((entry) => entry.message)).toEqual([
      'Ruflo remember skipped: the operator id is not a valid namespace',
    ]);
  });
});

describe('RufloCoordination.route', () => {
  test('passes the task to hooks_route and reads its advice', async () => {
    const session = new FakeSession({
      hooks_route: (args) =>
        textResult({ task: args.task, primaryAgent: { type: 'coder', confidence: 0.5 }, modelRouting: { tier: 2 } }),
    });
    const advice = await make(session).memory.route('Rename a variable');
    expect(session.calls[0]?.args).toEqual({ task: 'Rename a variable' });
    expect(advice).toEqual({ tier: 2, reason: 'Ruflo suggests a coder agent, 50% confidence; Ruflo recommends tier 2.' });
  });

  test('falls back to tier 3 with the reason when routing fails or times out', async () => {
    const failing = make(new FakeSession({ hooks_route: () => Promise.reject(new Error('Tool not found')) }));
    const hanging = make(new FakeSession({ hooks_route: () => never() }), 50);

    expect(await failing.memory.route('task')).toEqual({
      tier: 3,
      reason: 'Ruflo could not route this task (Tool not found), so the large model is used.',
    });
    expect((await hanging.memory.route('task')).reason).toContain('hooks_route timed out after 50 ms');
    expect(failing.entries[0]?.message).toBe('Ruflo routing failed; using the large model');
  });

  test('does not call a server that is gone', async () => {
    const session = new FakeSession({ hooks_route: () => textResult({}) });
    session.connected = false;
    expect(await make(session).memory.route('task')).toEqual({ tier: 3, reason: DISCONNECTED_REASON });
    expect(session.calls).toEqual([]);
  });
});

describe('RufloCoordination.close', () => {
  test('closes the session and runs the clean-up once', async () => {
    const session = new FakeSession();
    const onClosed = vi.fn();
    const memory = new RufloCoordination(session, capturingLogger().log, { onClosed });

    await memory.close();
    await memory.close();

    expect(memory.kind).toBe('ruflo');
    expect(session.closeCount).toBe(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test('still cleans up, and does not throw, when closing fails', async () => {
    const session = new FakeSession();
    session.closeError = new Error('EPIPE');
    const { log, entries } = capturingLogger();
    const memory = new RufloCoordination(session, log, {
      onClosed: () => {
        throw new Error('EBUSY');
      },
    });

    await expect(memory.close()).resolves.toBeUndefined();

    expect(entries.map((entry) => [entry.message, entry.fields?.error])).toEqual([
      ['closing the Ruflo connection failed', 'EPIPE'],
      ['cleaning up after Ruflo failed', 'EBUSY'],
    ]);
  });
});
