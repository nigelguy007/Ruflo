import type { Schedule, SignalResult } from '../../shared/types.js';
import type { ScheduleState, Store } from '../db/index.js';
import { errorMessage } from '../logger.js';
import type { Logger, NormalisedSignal } from '../ports.js';
import type { Catalog } from './catalog.js';
import type { DispatchOptions } from './dispatch.js';
import { iso, MINUTE_MS } from './time.js';
import type { Clock } from './time.js';

const DEFAULT_TICK_MS = 30_000;

export interface SchedulerDeps {
  catalog: Catalog;
  store: Store;
  dispatch: (signal: NormalisedSignal, opts?: DispatchOptions) => SignalResult;
  clock: Clock;
  log: Logger;
  tickMs?: number;
}

export interface Scheduler {
  /** Fires every schedule that is due at `now`. Returns what each firing started. */
  tick(now: Date): SignalResult[];
  start(): void;
  stop(): void;
}

/** Today's HH:MM in UTC, as a timestamp. */
function todayAt(dailyAt: string, now: Date): number {
  const [hours, minutes] = dailyAt.split(':').map(Number);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours ?? 0, minutes ?? 0);
}

/**
 * `everyMinutes` fires once a full interval has passed since the last firing
 * (or since the schedule was first seen). `dailyAt` fires once per UTC day,
 * at the first tick at or after HH:MM.
 */
export function isDue(schedule: Schedule, state: ScheduleState, now: Date): boolean {
  if (schedule.everyMinutes !== null) {
    const since = Date.parse(state.lastFiredAt ?? state.anchorAt);
    return now.getTime() - since >= schedule.everyMinutes * MINUTE_MS;
  }
  if (schedule.dailyAt === null) return false;
  const due = todayAt(schedule.dailyAt, now);
  if (now.getTime() < due) return false;
  return state.lastFiredAt === null || Date.parse(state.lastFiredAt) < due;
}

function scheduleSignal(schedule: Schedule, now: Date): NormalisedSignal {
  return {
    source: 'schedule',
    kind: 'schedule.fired',
    title: schedule.name,
    fingerprint: `schedule:${schedule.id}`,
    url: null,
    severity: 'info',
    payload: { scheduleId: schedule.id, firedAt: iso(now) },
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: NodeJS.Timeout | null = null;

  function fire(schedule: Schedule, now: Date): SignalResult | null {
    // Marked as fired first: a schedule whose playbook keeps failing to start must not fire on every tick.
    deps.store.scheduleState.markFired(schedule.id, iso(now));
    try {
      return deps.dispatch(scheduleSignal(schedule, now), { playbookId: schedule.playbookId });
    } catch (error) {
      deps.log.error('schedule could not start its playbook', {
        scheduleId: schedule.id,
        error: errorMessage(error),
      });
      return null;
    }
  }

  function tick(now: Date): SignalResult[] {
    const results: SignalResult[] = [];
    for (const schedule of deps.catalog.schedules) {
      if (!schedule.enabled) continue;
      deps.store.scheduleState.anchor(schedule.id, iso(now));
      const state = deps.store.scheduleState.get(schedule.id);
      if (!state || !isDue(schedule, state, now)) continue;
      const result = fire(schedule, now);
      if (result) results.push(result);
    }
    return results;
  }

  function safeTick(): void {
    try {
      tick(deps.clock());
    } catch (error) {
      deps.log.error('scheduler tick failed', { error: errorMessage(error) });
    }
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      safeTick();
      timer = setInterval(safeTick, deps.tickMs ?? DEFAULT_TICK_MS);
      // The scheduler alone must never keep the process alive.
      timer.unref();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
