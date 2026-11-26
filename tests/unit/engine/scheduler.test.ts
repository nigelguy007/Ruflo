import { describe, expect, test } from 'vitest';
import type { Schedule } from '../../../src/shared/types.js';
import type { ScheduleState } from '../../../src/server/db/index.js';
import { createScheduler, isDue } from '../../../src/server/engine/scheduler.js';
import type { Scheduler, SchedulerDeps } from '../../../src/server/engine/scheduler.js';
import { silentLogger } from '../../../src/server/logger.js';
import type { Logger } from '../../../src/server/ports.js';
import { agentStep, catalogOf, makeRig, playbook } from './support.js';
import type { Rig } from './support.js';

const nightly = playbook('nightly', [agentStep('check', 'inspector')]);

function schedule(extra: Partial<Schedule>): Schedule {
  return {
    id: 'every-half-hour',
    name: 'Every half hour',
    playbookId: 'nightly',
    enabled: true,
    everyMinutes: 30,
    dailyAt: null,
    ...extra,
  };
}

const halfHourly = schedule({});
const daily = schedule({ id: 'daily', name: 'Daily at 02:30', everyMinutes: null, dailyAt: '02:30' });
const disabled = schedule({ id: 'off', name: 'Switched off', enabled: false, everyMinutes: 1 });

const utc = (text: string): Date => new Date(`${text}Z`);

function setup(schedules: Schedule[], extra: Partial<SchedulerDeps> = {}): { rig: Rig; scheduler: Scheduler } {
  const rig = makeRig({ catalog: catalogOf({ playbooks: [nightly], schedules }) });
  const scheduler = createScheduler({
    catalog: rig.catalog,
    store: rig.store,
    dispatch: rig.engine.dispatch,
    clock: rig.time.clock,
    log: silentLogger,
    ...extra,
  });
  return { rig, scheduler };
}

/** How many firings each tick produced. */
function firings(scheduler: Scheduler, times: string[]): number[] {
  return times.map((time) => scheduler.tick(utc(time)).length);
}

describe('isDue', () => {
  const state = (anchorAt: string, lastFiredAt: string | null = null): ScheduleState => ({
    anchorAt: `${anchorAt}Z`,
    lastFiredAt: lastFiredAt === null ? null : `${lastFiredAt}Z`,
  });

  test('counts an interval from the last firing, or from the first sighting', () => {
    expect(isDue(halfHourly, state('2026-11-26T12:00:00'), utc('2026-11-26T12:29:59'))).toBe(false);
    expect(isDue(halfHourly, state('2026-11-26T12:00:00'), utc('2026-11-26T12:30:00'))).toBe(true);
    expect(isDue(halfHourly, state('2026-11-26T12:00:00', '2026-11-26T12:40:00'), utc('2026-11-26T13:00:00'))).toBe(false);
  });

  test('fires a daily schedule once per UTC day, at or after its time', () => {
    const fired = state('2026-11-25T00:00:00', '2026-11-26T02:30:00');

    expect(isDue(daily, state('2026-11-26T00:00:00'), utc('2026-11-26T02:29:59'))).toBe(false);
    expect(isDue(daily, state('2026-11-26T00:00:00'), utc('2026-11-26T02:30:00'))).toBe(true);
    expect(isDue(daily, fired, utc('2026-11-26T23:59:59'))).toBe(false);
    expect(isDue(daily, fired, utc('2026-11-27T02:29:59'))).toBe(false);
    expect(isDue(daily, fired, utc('2026-11-27T02:30:00'))).toBe(true);
  });

  test('is never due without a rule', () => {
    expect(isDue(schedule({ everyMinutes: null, dailyAt: null }), state('2026-11-26T00:00:00'), utc('2027-01-01T00:00:00'))).toBe(false);
  });
});

describe('scheduler', () => {
  test('fires an everyMinutes schedule once per interval, counted from when it was first seen', () => {
    const { scheduler } = setup([halfHourly]);

    const counts = firings(scheduler, [
      '2026-11-26T12:00:00',
      '2026-11-26T12:29:00',
      '2026-11-26T12:30:00',
      '2026-11-26T12:30:30',
      '2026-11-26T12:59:59',
      '2026-11-26T13:00:00',
      '2026-11-26T16:00:00',
      '2026-11-26T16:00:00',
    ]);

    expect(counts).toEqual([0, 0, 1, 0, 0, 1, 1, 0]);
  });

  test('starts the playbook with a schedule signal', async () => {
    const { rig, scheduler } = setup([halfHourly]);
    scheduler.tick(utc('2026-11-26T12:00:00'));

    const [result] = scheduler.tick(utc('2026-11-26T12:30:00'));
    await rig.engine.whenIdle();

    expect(result?.signal).toMatchObject({
      source: 'schedule',
      kind: 'schedule.fired',
      title: 'Every half hour',
      fingerprint: 'schedule:every-half-hour',
      severity: 'info',
      payload: { scheduleId: 'every-half-hour', firedAt: '2026-11-26T12:30:00.000Z' },
    });
    expect(result?.runs.map((r) => r.playbookId)).toEqual(['nightly']);
    expect(rig.run('run_1').status).toBe('succeeded');
  });

  test('fires a dailyAt schedule once per UTC day', () => {
    const { scheduler } = setup([daily]);

    const counts = firings(scheduler, [
      '2026-11-26T01:00:00',
      '2026-11-26T02:29:59',
      '2026-11-26T02:30:00',
      '2026-11-26T02:31:00',
      '2026-11-26T23:59:59',
      '2026-11-27T00:00:00',
      '2026-11-27T02:29:00',
      '2026-11-27T02:30:30',
      '2026-11-27T18:00:00',
    ]);

    expect(counts).toEqual([0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  test('catches up on a daily schedule first seen after its time of day', () => {
    const { scheduler } = setup([daily]);

    expect(firings(scheduler, ['2026-11-26T12:00:00', '2026-11-26T12:30:00'])).toEqual([1, 0]);
  });

  test('never fires or even records a disabled schedule', () => {
    const { rig, scheduler } = setup([disabled]);

    const counts = firings(scheduler, ['2026-11-26T12:00:00', '2026-11-26T13:00:00']);

    expect(counts).toEqual([0, 0]);
    expect(rig.store.scheduleState.get('off')).toBeNull();
  });

  test('remembers its last firing across a restart', () => {
    const { rig, scheduler } = setup([halfHourly]);
    firings(scheduler, ['2026-11-26T12:00:00', '2026-11-26T12:30:00']);
    const restarted = createScheduler({
      catalog: rig.catalog,
      store: rig.store,
      dispatch: rig.engine.dispatch,
      clock: rig.time.clock,
      log: silentLogger,
    });

    expect(firings(restarted, ['2026-11-26T12:45:00', '2026-11-26T13:00:00'])).toEqual([0, 1]);
  });

  test('logs a playbook that will not start and does not retry it on every tick', () => {
    const errors: unknown[] = [];
    const log: Logger = { ...silentLogger, error: (message, fields) => errors.push({ message, fields }) };
    let attempts = 0;
    const { scheduler } = setup([halfHourly], {
      log,
      dispatch: () => {
        attempts += 1;
        throw new Error('no such playbook');
      },
    });

    const counts = firings(scheduler, ['2026-11-26T12:00:00', '2026-11-26T12:30:00', '2026-11-26T12:31:00', '2026-11-26T13:00:00']);

    expect(counts).toEqual([0, 0, 0, 0]);
    expect(attempts).toBe(2);
    expect(errors[0]).toEqual({
      message: 'schedule could not start its playbook',
      fields: { scheduleId: 'every-half-hour', error: 'no such playbook' },
    });
  });

  test('ticks once as soon as it starts, and can be stopped and started again', async () => {
    const { rig, scheduler } = setup([daily]);

    scheduler.start();
    scheduler.start();
    await rig.engine.whenIdle();
    scheduler.stop();
    scheduler.stop();
    scheduler.start();
    scheduler.stop();

    expect(rig.store.scheduleState.get('daily')?.lastFiredAt).toBe('2026-11-26T12:00:00.000Z');
    expect(rig.engine.runs({ limit: 10 }).total).toBe(1);
  });
});
