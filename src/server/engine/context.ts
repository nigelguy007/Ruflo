import type { Harness, Id } from '../../shared/types.js';
import type { Config } from '../config.js';
import type { Store } from '../db/index.js';
import type { CommandRunner, Coordination, Executor, Logger } from '../ports.js';
import type { EventBus } from './bus.js';
import type { Catalog } from './catalog.js';
import type { Ledger } from './ledger.js';
import type { Clock, IdGenerator, Sleep } from './time.js';

/** Everything the engine is built from. All of it can be replaced in tests. */
export interface EngineDeps {
  config: Config;
  store: Store;
  catalog: Catalog;
  bus: EventBus;
  ledger: Ledger;
  executors: Record<Harness, Executor>;
  commandRunner: CommandRunner;
  coordination: Coordination;
  log: Logger;
  clock: Clock;
  newId: IdGenerator;
  sleep: Sleep;
}

/** The dependencies plus the little runtime state the engine modules share. */
export interface EngineContext extends EngineDeps {
  /** Abort handle for the step each run is executing right now. */
  readonly inflight: Map<Id, AbortController>;
  /** Set while shutting down: in-flight steps stop without recording anything, so recovery reruns them. */
  readonly lifecycle: { stopping: boolean };
  /** Hands a run to the queue; safe to call for a run that is already queued or running. */
  enqueue(runId: Id): void;
  /** Tracks fire-and-forget work so shutdown and tests can wait for it. */
  background(task: Promise<void>): void;
}

/** "system" and "human" are the two non-operator actors on the timeline. */
export const SYSTEM_ACTOR = 'system';
export const HUMAN_ACTOR = 'human';
