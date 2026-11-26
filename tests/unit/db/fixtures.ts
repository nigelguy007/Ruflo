import type { Decision, Evidence, Playbook, Signal, TimelineEvent } from '../../../src/shared/types.js';
import { createStore } from '../../../src/server/db/index.js';
import type { NewRun, Store } from '../../../src/server/db/index.js';
import { agentStep, commandStep, gateStep, playbook, START } from '../engine/support.js';

export const PLAYBOOK: Playbook = playbook('fix-it', [
  agentStep('look', 'inspector'),
  commandStep('tests', ['npm', 'test'], { expectExit: 0 }),
  gateStep('approve'),
]);

export function at(minutes: number): string {
  return new Date(Date.parse(START) + minutes * 60_000).toISOString();
}

export function storedSignal(id: string, extra: Partial<Signal> = {}): Signal {
  return {
    id,
    source: 'manual',
    kind: 'manual.run',
    title: `Signal ${id}`,
    fingerprint: `fp-${id}`,
    url: null,
    severity: 'error',
    payload: {},
    receivedAt: START,
    ...extra,
  };
}

/** A store with one signal per run id, so runs can be inserted against it. */
export function storeWithSignals(...ids: string[]): Store {
  const store = createStore(':memory:');
  for (const id of ids) store.signals.insert(storedSignal(`sig-${id}`));
  return store;
}

export function newRun(id: string, extra: Partial<NewRun> = {}): NewRun {
  return {
    id,
    playbook: PLAYBOOK,
    signalId: `sig-${id}`,
    fingerprint: `fp-${id}`,
    title: `Run ${id}`,
    createdAt: START,
    ...extra,
  };
}

export function evidence(id: string, runId: string, ok: boolean | null = true): Evidence {
  return { id, runId, stepId: 'tests', kind: 'verified', label: `Evidence ${id}`, detail: 'exit code 0', ok };
}

export function openDecision(id: string, runId: string, extra: Partial<Decision> = {}): Decision {
  return {
    id,
    runId,
    runTitle: `Run ${runId}`,
    stepId: 'approve',
    question: 'Ship it?',
    status: 'open',
    openedAt: START,
    decidedAt: null,
    decidedBy: null,
    note: null,
    evidence: [],
    ...extra,
  };
}

export function timelineEvent(seq: number, runId: string, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    seq,
    id: `evt_${seq}`,
    runId,
    at: START,
    actor: 'system',
    kind: 'note',
    text: `Entry ${seq}`,
    mentions: [],
    data: null,
    prevHash: '0'.repeat(64),
    hash: `${seq}`.padStart(64, 'f'),
    ...extra,
  };
}
