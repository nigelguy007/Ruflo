import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSimulatedExecutor, simulateStep } from '../../../src/server/executors/simulated.js';
import { operatorsFileSchema, playbookSchema } from '../../../src/shared/schemas.js';
import type { AgentStep } from '../../../src/shared/types.js';
import { SIGNAL_TITLE, makeContext, makeOperator, makeRun, makeSignal, makeStep } from './helpers.js';

const CONFIG_DIR = join(process.cwd(), 'config');

const operators = operatorsFileSchema.parse(
  JSON.parse(readFileSync(join(CONFIG_DIR, 'operators.json'), 'utf8')),
);
const playbooks = readdirSync(join(CONFIG_DIR, 'playbooks'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => playbookSchema.parse(JSON.parse(readFileSync(join(CONFIG_DIR, 'playbooks', file), 'utf8'))));

/** Every agent step of every seed playbook, with the operator that runs it. */
const seedSteps = playbooks.flatMap((playbook) =>
  playbook.steps
    .filter((step): step is AgentStep => step.kind === 'agent')
    .map((step) => ({ name: `${playbook.id} / ${step.id}`, playbook, step })),
);

function contextFor(entry: (typeof seedSteps)[number]): ReturnType<typeof makeContext> {
  const operator = operators.find((candidate) => candidate.id === entry.step.operator);
  return makeContext({
    run: makeRun({ playbookId: entry.playbook.id, playbookName: entry.playbook.name }),
    step: entry.step,
    operator: makeOperator({ ...operator }),
  });
}

function sentenceCount(summary: string): number {
  const withoutTitle = summary.replaceAll(SIGNAL_TITLE, 'the signal');
  return withoutTitle.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scripts for the seed playbooks', () => {
  test('cover the four playbooks shipped in config/playbooks', () => {
    expect(playbooks.map((playbook) => playbook.id).sort()).toEqual([
      'error-to-fix',
      'nightly-dependency-check',
      'red-main',
      'review-pull-request',
    ]);
    expect(seedSteps).toHaveLength(9);
  });

  test.each(seedSteps)('$name has its own script rather than the generic fallback', (entry) => {
    const result = simulateStep(contextFor(entry));

    expect(result.ok).toBe(true);
    expect(result.claims.map((claim) => claim.label)).not.toContain('Simulated step');
  });

  test.each(seedSteps)('$name reads as being about the signal', (entry) => {
    const result = simulateStep(contextFor(entry));

    expect(result.summary).toContain(SIGNAL_TITLE);
  });

  test.each(seedSteps)('$name summarises in two or three sentences', (entry) => {
    const result = simulateStep(contextFor(entry));

    expect(sentenceCount(result.summary)).toBeGreaterThanOrEqual(2);
    expect(sentenceCount(result.summary)).toBeLessThanOrEqual(3);
  });

  test.each(seedSteps)('$name makes specific claims and produces only simulated artifacts', (entry) => {
    const result = simulateStep(contextFor(entry));

    expect(result.claims.length).toBeGreaterThanOrEqual(3);
    for (const claim of result.claims) {
      expect(claim.label.length).toBeGreaterThan(0);
      expect(claim.detail.length).toBeGreaterThan(15);
    }
    expect(result.artifacts.length).toBeGreaterThan(0);
    for (const artifact of result.artifacts) {
      expect(artifact.value).toMatch(/^simulated:\/\//);
      expect(artifact.value).not.toMatch(/https?:/);
    }
  });

  test.each(seedSteps)('$name is deterministic', (entry) => {
    const first = simulateStep(contextFor(entry));
    const second = simulateStep(contextFor(entry));

    expect(second).toEqual(first);
  });

  test('gives each pull request in the seed playbooks a distinct simulated location', () => {
    const pullRequests = seedSteps
      .flatMap((entry) => simulateStep(contextFor(entry)).artifacts)
      .filter((artifact) => artifact.kind === 'pr')
      .map((artifact) => artifact.value)
      .sort();

    expect(pullRequests).toEqual([
      'simulated://pull-request/1',
      'simulated://pull-request/2',
      'simulated://pull-request/3',
    ]);
  });
});

describe('generic fallback', () => {
  const unknownStep = makeContext({
    run: makeRun({ playbookId: 'custom-playbook' }),
    step: makeStep({ id: 'audit-logs', title: 'Audit the access logs' }),
    operator: makeOperator({ name: 'Inspector' }),
    prior: [{ stepId: 'collect', title: 'Collect logs', summary: 'Collected.' }],
  });

  test('builds a result from the step, the operator and the signal', () => {
    const result = simulateStep(unknownStep);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Inspector');
    expect(result.summary).toContain('Audit the access logs');
    expect(result.summary).toContain(SIGNAL_TITLE);
    expect(result.summary).toContain('It follows 1 earlier step in this run.');
    expect(result.artifacts).toEqual([
      { kind: 'log', label: 'Simulated session', value: 'simulated://session/custom-playbook/audit-logs' },
    ]);
  });

  test('says plainly that no script exists for the step', () => {
    const result = simulateStep(unknownStep);

    expect(result.claims[0]).toMatchObject({ label: 'Simulated step', ok: null });
    expect(result.claims[0]?.detail).toContain('"audit-logs"');
  });

  test('is used for an unknown step of a known playbook', () => {
    const result = simulateStep(makeContext({ step: makeStep({ id: 'not-a-seed-step' }) }));

    expect(result.claims.map((claim) => claim.label)).toContain('Simulated step');
  });

  test('is not fooled by step ids that name object prototype members', () => {
    const result = simulateStep(makeContext({ step: makeStep({ id: 'constructor' }) }));

    expect(result.claims.map((claim) => claim.label)).toContain('Simulated step');
  });

  test('notes when it is the first step of the run', () => {
    const result = simulateStep(makeContext({ step: makeStep({ id: 'unknown' }), prior: [] }));

    expect(result.summary).toContain('It is the first step of the run.');
  });
});

describe('signal and memory handling', () => {
  test('shortens a very long signal title inside the summary', () => {
    const signal = makeSignal({ title: `Checkout fails ${'again and again '.repeat(30)}` });

    const result = simulateStep(makeContext({ signal }));

    expect(result.summary).toContain('Checkout fails again and again');
    expect(result.summary).toContain('…');
    expect(result.summary.length).toBeLessThan(600);
  });

  test('falls back to a neutral phrase when the signal has no title', () => {
    const result = simulateStep(makeContext({ signal: makeSignal({ title: '   ' }) }));

    expect(result.summary).toContain('"this signal"');
  });

  test('adds a claim about recalled memory when the operator remembered something', () => {
    const recalled = [
      { key: 'run-9', text: 'Last month the same handler crashed on an empty cart.', score: 0.82 },
      { key: 'run-4', text: 'Unrelated note.', score: 0.31 },
    ];

    const result = simulateStep(makeContext({ recalled }));

    expect(result.claims.at(-1)).toEqual({
      label: 'Recalled memory',
      detail: '2 earlier notes looked related; the closest was "Last month the same handler crashed on an empty cart.".',
      ok: null,
    });
  });

  test('adds no memory claim when nothing was recalled', () => {
    const result = simulateStep(makeContext());

    expect(result.claims.map((claim) => claim.label)).not.toContain('Recalled memory');
  });
});

describe('createSimulatedExecutor', () => {
  test('reports the harness it stands in for', () => {
    expect(createSimulatedExecutor(0).harness).toBe('simulated');
    expect(createSimulatedExecutor(0, 'claude').harness).toBe('claude');
  });

  test('says it is synthetic, whichever harness it stands in for, so its output is never recorded as claimed', () => {
    expect(createSimulatedExecutor(0).synthetic).toBe(true);
    expect(createSimulatedExecutor(0, 'claude').synthetic).toBe(true);
    expect(createSimulatedExecutor(0, 'codex').synthetic).toBe(true);
  });

  test('waits for the step delay before resolving', async () => {
    // Arrange
    vi.useFakeTimers();
    const executor = createSimulatedExecutor(900);
    let settled = false;

    // Act
    const pending = executor.run(makeContext(), new AbortController().signal).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(899);
    const settledEarly = settled;
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    // Assert
    expect(settledEarly).toBe(false);
    expect(result.summary).toContain(SIGNAL_TITLE);
  });

  test('rejects promptly with an AbortError when the signal fires mid-wait', async () => {
    // Arrange
    const executor = createSimulatedExecutor(60_000);
    const controller = new AbortController();
    const startedAt = Date.now();

    // Act
    const pending = executor.run(makeContext(), controller.signal);
    setTimeout(() => controller.abort(), 10);

    // Assert
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('rejects straight away when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const pending = createSimulatedExecutor(60_000).run(makeContext(), controller.signal);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
