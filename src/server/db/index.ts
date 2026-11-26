import type { DatabaseSync } from 'node:sqlite';
import { createTransaction, openDatabase } from './database.js';
import { DecisionRepository } from './decisions.js';
import { createEvidenceRepository } from './evidence.js';
import type { EvidenceRepository } from './evidence.js';
import { RunRepository } from './runs.js';
import { createSignalRepository } from './signals.js';
import type { SignalRepository } from './signals.js';
import {
  createScheduleStateRepository,
  createSettingsRepository,
  createWatchOverrideRepository,
} from './state.js';
import type {
  ScheduleStateRepository,
  SettingsRepository,
  WatchOverrideRepository,
} from './state.js';
import { TimelineRepository } from './timeline.js';

/** Everything the server persists, behind typed repositories. */
export interface Store {
  /** Exposed for tests and maintenance; application code goes through the repositories. */
  readonly db: DatabaseSync;
  readonly signals: SignalRepository;
  readonly runs: RunRepository;
  readonly timeline: TimelineRepository;
  readonly evidence: EvidenceRepository;
  readonly decisions: DecisionRepository;
  readonly settings: SettingsRepository;
  readonly watchOverrides: WatchOverrideRepository;
  readonly scheduleState: ScheduleStateRepository;
  /** Runs `work` in one transaction; nested calls join the outer one. */
  transaction<T>(work: () => T): T;
  close(): void;
}

/** Opens (and migrates) the database at `path`; pass ":memory:" for a throwaway store. */
export function createStore(path: string): Store {
  const db = openDatabase(path);
  let open = true;
  return {
    db,
    signals: createSignalRepository(db),
    runs: new RunRepository(db),
    timeline: new TimelineRepository(db),
    evidence: createEvidenceRepository(db),
    decisions: new DecisionRepository(db),
    settings: createSettingsRepository(db),
    watchOverrides: createWatchOverrideRepository(db),
    scheduleState: createScheduleStateRepository(db),
    transaction: createTransaction(db),
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}

export { ACTIVE_STATUSES, RUN_STATUSES } from './runs.js';
export type { DigestCounts, NewRun, RunFilter, RunMeta, RunPatch, StepPatch } from './runs.js';
export { DECISION_STATUSES } from './decisions.js';
export type { DecisionFilter, Resolution } from './decisions.js';
export type { LedgerRow, LedgerTip } from './timeline.js';
export type { ScheduleState } from './state.js';
