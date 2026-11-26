import { afterEach, describe, expect, test } from 'vitest';
import type { Store } from '../../../src/server/db/index.js';
import { ACTIVE_STATUSES } from '../../../src/server/db/index.js';
import { START } from '../engine/support.js';
import { at, newRun, openDecision, PLAYBOOK, storeWithSignals } from './fixtures.js';

let store: Store | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

function open(...ids: string[]): Store {
  store = storeWithSignals(...ids);
  return store;
}

describe('run repository', () => {
  test('stores a new run queued, with one pending step per playbook step', () => {
    const s = open('a');

    const run = s.runs.insert(newRun('a'));

    expect(run).toEqual({
      id: 'a',
      playbookId: 'fix-it',
      playbookName: 'Playbook fix-it',
      playbookVersion: 1,
      signalId: 'sig-a',
      title: 'Run a',
      status: 'queued',
      createdAt: START,
      startedAt: null,
      finishedAt: null,
      currentStepId: null,
      stopReason: null,
      duplicateSignals: 0,
      steps: [
        { stepId: 'look', kind: 'agent', title: 'Do look', operator: 'inspector', status: 'pending', attempt: 0, startedAt: null, finishedAt: null, summary: null },
        { stepId: 'tests', kind: 'command', title: 'Run tests', operator: null, status: 'pending', attempt: 0, startedAt: null, finishedAt: null, summary: null },
        { stepId: 'approve', kind: 'gate', title: 'Decide approve', operator: null, status: 'pending', attempt: 0, startedAt: null, finishedAt: null, summary: null },
      ],
    });
    expect(s.runs.get('a')).toEqual(run);
  });

  test('keeps a snapshot of the playbook and the bookkeeping the API never shows', () => {
    const s = open('a');
    s.runs.insert(newRun('a'));

    expect(s.runs.playbook('a')).toEqual(PLAYBOOK);
    expect(s.runs.meta('a')).toEqual({ fingerprint: 'fp-a', parked: false, gateWaitMs: 0, agentStepsStarted: 0, handoffs: 0 });
    expect(s.runs.playbook('missing')).toBeNull();
    expect(s.runs.meta('missing')).toBeNull();
  });

  test('answers null for an unknown run, and require says which one is missing', () => {
    const s = open();

    expect(s.runs.get('nope')).toBeNull();
    expect(() => s.runs.require('nope')).toThrow('Run nope does not exist.');
  });

  test('refuses a run whose signal is not stored', () => {
    const s = open();

    expect(() => s.runs.insert(newRun('orphan'))).toThrow();
  });

  test('applies patches, adding to the counters rather than replacing them', () => {
    const s = open('a');
    s.runs.insert(newRun('a'));

    s.runs.update('a', { status: 'running', startedAt: at(1), currentStepId: 'look', parked: true });
    s.runs.update('a', { addDuplicateSignals: 2, addGateWaitMs: 1_500.6, addAgentStepsStarted: 1, addHandoffs: 1 });
    const run = s.runs.update('a', { addDuplicateSignals: 1, addGateWaitMs: -50, addHandoffs: 2, stopReason: 'why' });

    expect(run).toMatchObject({ status: 'running', startedAt: at(1), currentStepId: 'look', duplicateSignals: 3, stopReason: 'why' });
    expect(s.runs.meta('a')).toEqual({ fingerprint: 'fp-a', parked: true, gateWaitMs: 1_501, agentStepsStarted: 1, handoffs: 3 });
    expect(s.runs.update('a', {})).toEqual(run);
  });

  test('updates one step at a time', () => {
    const s = open('a');
    s.runs.insert(newRun('a'));

    const run = s.runs.updateStep('a', 'tests', { status: 'running', attempt: 1, startedAt: at(2), summary: 'busy' });

    expect(run.steps.map((step) => step.status)).toEqual(['pending', 'running', 'pending']);
    expect(run.steps[1]).toMatchObject({ attempt: 1, startedAt: at(2), summary: 'busy' });
    expect(s.runs.updateStep('a', 'tests', {})).toEqual(run);
  });

  test('skips every step that has not finished', () => {
    const s = open('a');
    s.runs.insert(newRun('a'));
    s.runs.updateStep('a', 'look', { status: 'succeeded' });
    s.runs.updateStep('a', 'tests', { status: 'running' });

    const run = s.runs.skipOpenSteps('a');

    expect(run.steps.map((step) => step.status)).toEqual(['succeeded', 'skipped', 'skipped']);
  });

  test('puts a step that was mid-flight back to pending', () => {
    const s = open('a');
    s.runs.insert(newRun('a'));
    s.runs.updateStep('a', 'look', { status: 'running', attempt: 1, startedAt: at(1) });

    const run = s.runs.resetRunningSteps('a');

    expect(run.steps[0]).toMatchObject({ status: 'pending', startedAt: null, attempt: 1 });
  });

  test('lists newest first, filtered by status, and counts the same way', () => {
    const s = open('a', 'b', 'c', 'd');
    for (const id of ['a', 'b', 'c', 'd']) s.runs.insert(newRun(id));
    s.runs.update('a', { status: 'succeeded' });
    s.runs.update('c', { status: 'waiting_gate' });

    expect(s.runs.list({ limit: 10 }).map((r) => r.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(s.runs.list({ limit: 2 }).map((r) => r.id)).toEqual(['d', 'c']);
    expect(s.runs.list({ statuses: ['queued'], limit: 10 }).map((r) => r.id)).toEqual(['d', 'b']);
    expect(s.runs.list({ statuses: ['succeeded', 'waiting_gate'], limit: 10 }).map((r) => r.id)).toEqual(['c', 'a']);
    expect(s.runs.list({ statuses: [], limit: 10 })).toHaveLength(4);
    expect(s.runs.list({ limit: 10 })[0]?.steps).toHaveLength(3);
    expect(s.runs.count()).toBe(4);
    expect(s.runs.count(ACTIVE_STATUSES)).toBe(3);
    expect(s.runs.count(['failed'])).toBe(0);
  });

  test('finds the newest active run for the same playbook and fingerprint inside the window', () => {
    const s = open('old', 'new', 'done', 'other');
    s.runs.insert(newRun('old', { fingerprint: 'fp', createdAt: at(0) }));
    s.runs.insert(newRun('new', { fingerprint: 'fp', createdAt: at(10) }));
    s.runs.insert(newRun('done', { fingerprint: 'fp', createdAt: at(20) }));
    s.runs.update('done', { status: 'failed' });
    s.runs.insert(newRun('other', { fingerprint: 'fp', createdAt: at(30), playbook: { ...PLAYBOOK, id: 'other' } }));

    expect(s.runs.findActiveDuplicate('fix-it', 'fp', at(0))?.id).toBe('new');
    expect(s.runs.findActiveDuplicate('fix-it', 'fp', at(11))).toBeNull();
    expect(s.runs.findActiveDuplicate('fix-it', 'other-fp', at(0))).toBeNull();
    expect(s.runs.findActiveDuplicate('other', 'fp', at(0))?.id).toBe('other');
  });

  test('lists the runs held back by the pause, oldest first', () => {
    const s = open('a', 'b', 'c');
    for (const id of ['a', 'b', 'c']) s.runs.insert(newRun(id));
    s.runs.update('b', { parked: true });
    s.runs.update('a', { parked: true, status: 'running' });
    s.runs.update('c', { parked: true, status: 'cancelled' });

    expect(s.runs.listParked().map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('counts how runs ended since a moment, and which never asked anyone', () => {
    const s = open('a', 'b', 'c', 'd', 'e', 'f');
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) s.runs.insert(newRun(id));
    s.runs.update('a', { status: 'succeeded', finishedAt: at(5) });
    s.runs.update('b', { status: 'succeeded', finishedAt: at(5) });
    s.decisions.insert(openDecision('dec-b', 'b', { status: 'approved' }));
    s.runs.update('c', { status: 'failed', finishedAt: at(5) });
    s.runs.update('d', { status: 'cancelled', finishedAt: at(5) });
    s.runs.update('e', { status: 'rejected', finishedAt: at(5) });
    s.runs.update('f', { status: 'succeeded', finishedAt: at(-60) });

    expect(s.runs.digestCounts(at(0))).toEqual({ succeeded: 2, failed: 1, rejected: 1, cancelled: 1, handledWithoutYou: 1 });
    expect(s.runs.digestCounts(at(10))).toEqual({ succeeded: 0, failed: 0, rejected: 0, cancelled: 0, handledWithoutYou: 0 });
  });

  test('fails loudly on a row edited into something it does not understand', () => {
    const s = open('a');
    s.runs.insert(newRun('a'));
    s.db.prepare("UPDATE runs SET status = 'exploded' WHERE id = 'a'").run();

    expect(() => s.runs.get('a')).toThrow('Column status holds an unknown value.');
  });
});
