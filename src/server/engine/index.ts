import type {
  Decision,
  Id,
  LedgerCheck,
  Operator,
  Overview,
  Playbook,
  Run,
  RunDetail,
  Schedule,
  Settings,
  Signal,
  SignalResult,
  Verdict,
  Watch,
} from '../../shared/types.js';
import type { DecisionFilter, RunFilter } from '../db/index.js';
import type { NormalisedSignal } from '../ports.js';
import type { EngineContext, EngineDeps } from './context.js';
import { cancel, decide } from './decisions.js';
import { dispatch, listWatches, setWatchEnabled } from './dispatch.js';
import type { DispatchOptions } from './dispatch.js';
import { EngineError, ShutdownError } from './errors.js';
import { buildOverview, listOperators } from './overview.js';
import { createRunQueue } from './queue.js';
import { recover } from './recovery.js';
import { createRunner } from './runner.js';

export interface Page<T> {
  items: T[];
  total: number;
}

/** The one object the HTTP layer and the scheduler talk to. */
export interface Engine {
  /** Stores a signal and starts (or joins) the runs it calls for. */
  dispatch(signal: NormalisedSignal, opts?: DispatchOptions): SignalResult;
  decide(id: Id, verdict: Verdict, note: string | null | undefined, by: string): Decision;
  cancel(runId: Id): Run;
  /** Call once at boot, before serving. Returns how many runs were picked up again. */
  recover(): number;
  setPaused(paused: boolean): Settings;
  setWatchEnabled(id: Id, enabled: boolean): Watch;
  settings(): Settings;
  overview(): Overview;
  operators(): Operator[];
  playbooks(): Playbook[];
  watches(): Watch[];
  schedules(): Schedule[];
  signals(limit: number): Page<Signal>;
  runs(filter: RunFilter): Page<Run>;
  runDetail(id: Id): RunDetail;
  decisions(filter: DecisionFilter): Page<Decision>;
  verifyLedger(): LedgerCheck;
  /** Resolves when no run is being advanced and no background work is pending. */
  whenIdle(): Promise<void>;
  /** Stops starting work and aborts what is in flight; interrupted runs resume at the next boot. */
  shutdown(): Promise<void>;
}

function createContext(deps: EngineDeps): { ctx: EngineContext; whenIdle: () => Promise<void>; close: () => void } {
  const background = new Set<Promise<void>>();
  const ctx: EngineContext = {
    ...deps,
    inflight: new Map(),
    lifecycle: { stopping: false },
    enqueue: (runId) => queue.enqueue(runId),
    background: (task) => {
      background.add(task);
      void task.finally(() => background.delete(task));
    },
  };
  const queue = createRunQueue(deps.config.concurrency, createRunner(ctx), deps.log);
  const whenIdle = async (): Promise<void> => {
    for (;;) {
      await queue.whenIdle();
      if (background.size === 0) return;
      await Promise.allSettled([...background]);
    }
  };
  return { ctx, whenIdle, close: () => queue.close() };
}

function runDetail(ctx: EngineContext, id: Id): RunDetail {
  const run = ctx.store.runs.get(id);
  if (!run) throw new EngineError('not_found', `Run ${id} does not exist.`);
  const signal = ctx.store.signals.get(run.signalId);
  if (!signal) throw new Error(`Run ${id} points at a signal that is missing.`);
  return {
    run,
    signal,
    timeline: ctx.store.timeline.forRun(id),
    evidence: ctx.store.evidence.forRun(id),
    decision: ctx.store.decisions.openForRun(id) ?? ctx.store.decisions.latestForRun(id),
  };
}

function setPaused(ctx: EngineContext, paused: boolean): Settings {
  if (ctx.store.settings.paused() !== paused) {
    ctx.store.settings.setPaused(paused);
    ctx.bus.publish({ type: 'settings.updated', settings: { paused, mode: ctx.config.mode } });
    // Lifting the pause puts every run it was holding back in the queue.
    if (!paused) for (const run of ctx.store.runs.listParked()) ctx.enqueue(run.id);
  }
  return { paused, mode: ctx.config.mode };
}

export function createEngine(deps: EngineDeps): Engine {
  const { ctx, whenIdle, close } = createContext(deps);
  const { store, catalog, config } = deps;
  return {
    dispatch: (signal, opts) => dispatch(ctx, signal, opts),
    decide: (id, verdict, note, by) => decide(ctx, id, verdict, note, by),
    cancel: (runId) => cancel(ctx, runId),
    recover: () => recover(ctx),
    setPaused: (paused) => setPaused(ctx, paused),
    setWatchEnabled: (id, enabled) => setWatchEnabled(ctx, id, enabled),
    settings: () => ({ paused: store.settings.paused(), mode: config.mode }),
    overview: () => buildOverview(ctx),
    operators: () => listOperators(ctx),
    playbooks: () => [...catalog.playbooks],
    watches: () => listWatches(ctx),
    schedules: () => [...catalog.schedules],
    signals: (limit) => ({ items: store.signals.list(limit), total: store.signals.count() }),
    runs: (filter) => ({ items: store.runs.list(filter), total: store.runs.count(filter.statuses) }),
    runDetail: (id) => runDetail(ctx, id),
    decisions: (filter) => ({
      items: store.decisions.list(filter),
      total: store.decisions.count(filter.status),
    }),
    verifyLedger: () => deps.ledger.verify(),
    whenIdle,
    async shutdown() {
      ctx.lifecycle.stopping = true;
      close();
      for (const abort of ctx.inflight.values()) abort.abort(new ShutdownError());
      await whenIdle();
    },
  };
}

export { EngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export type { EngineDeps } from './context.js';
export type { DispatchOptions } from './dispatch.js';
