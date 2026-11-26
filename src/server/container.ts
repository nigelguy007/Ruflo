import type { Hono } from 'hono';
import packageJson from '../../package.json' with { type: 'json' };
import type { Harness } from '../shared/types.js';
import type { Config } from './config.js';
import { createCoordination } from './coordination/index.js';
import { createStore } from './db/index.js';
import type { Store } from './db/index.js';
import { createEventBus } from './engine/bus.js';
import type { EventBus } from './engine/bus.js';
import { loadCatalog } from './engine/catalog.js';
import type { Catalog } from './engine/catalog.js';
import { createEngine } from './engine/index.js';
import type { Engine } from './engine/index.js';
import { createLedger } from './engine/ledger.js';
import { createScheduler } from './engine/scheduler.js';
import type { Scheduler } from './engine/scheduler.js';
import { randomId, systemClock, timerSleep } from './engine/time.js';
import type { Clock, IdGenerator, Sleep } from './engine/time.js';
import { createCommandRunner, createExecutors } from './executors/index.js';
import { createApp } from './http/index.js';
import type { HookSource } from './http/index.js';
import { createLogger, errorMessage } from './logger.js';
import type { CommandRunner, Coordination, Executor, Logger, SignalAdapter } from './ports.js';
import { signalAdapters } from './signals/index.js';

/** Everything that can be swapped out, for tests and for embedding. */
export interface ContainerOverrides {
  executors?: Record<Harness, Executor>;
  commandRunner?: CommandRunner;
  coordination?: Coordination;
  signalAdapters?: Readonly<Record<HookSource, SignalAdapter>>;
  clock?: Clock;
  newId?: IdGenerator;
  sleep?: Sleep;
  log?: Logger;
}

export interface Container {
  app: Hono;
  engine: Engine;
  scheduler: Scheduler;
  store: Store;
  bus: EventBus;
  /** Stops the scheduler and the engine, then closes coordination and the store. Safe to call twice. */
  close(): Promise<void>;
}

export const VERSION: string = packageJson.version;

interface Core {
  store: Store;
  catalog: Catalog;
  coordination: Coordination;
}

/** The parts that hold resources. The store is closed again if anything after it fails. */
async function openCore(config: Config, log: Logger, overrides: ContainerOverrides): Promise<Core> {
  const store = createStore(config.dbPath);
  try {
    const catalog = loadCatalog(config.configDir);
    const coordination = overrides.coordination ?? (await createCoordination(config, log));
    return { store, catalog, coordination };
  } catch (error) {
    store.close();
    throw error;
  }
}

function closer(scheduler: Scheduler, engine: Engine, core: Core, log: Logger): () => Promise<void> {
  let closing: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    scheduler.stop();
    await engine.shutdown();
    try {
      await core.coordination.close();
    } catch (error) {
      log.warn('coordination did not close cleanly', { error: errorMessage(error) });
    }
    core.store.close();
  };
  return () => {
    closing ??= close();
    return closing;
  };
}

/** Builds the whole server from its configuration. Nothing starts running until the caller says so. */
export async function createContainer(
  config: Config,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  const log = overrides.log ?? createLogger('switchyard');
  const clock = overrides.clock ?? systemClock;
  const newId = overrides.newId ?? randomId;
  const core = await openCore(config, log, overrides);
  const bus = createEventBus(log);
  const engine = createEngine({
    config,
    store: core.store,
    catalog: core.catalog,
    bus,
    ledger: createLedger(core.store, bus, clock, newId),
    executors: overrides.executors ?? createExecutors(config, log),
    commandRunner: overrides.commandRunner ?? createCommandRunner(config, log),
    coordination: core.coordination,
    log,
    clock,
    newId,
    sleep: overrides.sleep ?? timerSleep,
  });
  const scheduler = createScheduler({
    catalog: core.catalog,
    store: core.store,
    dispatch: (signal, opts) => engine.dispatch(signal, opts),
    clock,
    log,
  });
  const app = createApp({
    config,
    engine,
    bus,
    adapters: overrides.signalAdapters ?? signalAdapters,
    coordination: core.coordination.kind,
    version: VERSION,
    log,
    clock,
  });
  return { app, engine, scheduler, store: core.store, bus, close: closer(scheduler, engine, core, log) };
}
