import type { DatabaseSync } from 'node:sqlite';
import type { Id, IsoTime } from '../../shared/types.js';
import { integer, text, textOrNull } from './rows.js';

const PAUSED_KEY = 'paused';

// ── Settings ─────────────────────────────────────────────────────────────────

export interface SettingsRepository {
  paused(): boolean;
  setPaused(paused: boolean): void;
}

export function createSettingsRepository(db: DatabaseSync): SettingsRepository {
  const read = db.prepare('SELECT value FROM settings WHERE key = ?');
  const write = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
  return {
    paused() {
      const row = read.get(PAUSED_KEY);
      return row ? text(row, 'value') === 'true' : false;
    },
    setPaused(paused) {
      write.run(PAUSED_KEY, paused ? 'true' : 'false');
    },
  };
}

// ── Watch enabled-overrides ──────────────────────────────────────────────────

/** A watch's `enabled` flag as changed from the console; config files stay untouched. */
export interface WatchOverrideRepository {
  all(): Map<Id, boolean>;
  set(watchId: Id, enabled: boolean): void;
}

export function createWatchOverrideRepository(db: DatabaseSync): WatchOverrideRepository {
  const readAll = db.prepare('SELECT watch_id, enabled FROM watch_overrides');
  const write = db.prepare(
    `INSERT INTO watch_overrides (watch_id, enabled) VALUES (?, ?)
     ON CONFLICT (watch_id) DO UPDATE SET enabled = excluded.enabled`,
  );
  return {
    all() {
      const rows = readAll.all();
      return new Map(rows.map((row) => [text(row, 'watch_id'), integer(row, 'enabled') !== 0]));
    },
    set(watchId, enabled) {
      write.run(watchId, enabled ? 1 : 0);
    },
  };
}

// ── Schedule last-fired state ────────────────────────────────────────────────

export interface ScheduleState {
  /** When the scheduler first saw this schedule; intervals count from here. */
  anchorAt: IsoTime;
  lastFiredAt: IsoTime | null;
}

export interface ScheduleStateRepository {
  get(scheduleId: Id): ScheduleState | null;
  /** Records the first sighting. Does nothing when the schedule is already known. */
  anchor(scheduleId: Id, at: IsoTime): void;
  markFired(scheduleId: Id, at: IsoTime): void;
}

export function createScheduleStateRepository(db: DatabaseSync): ScheduleStateRepository {
  const read = db.prepare('SELECT anchor_at, last_fired_at FROM schedule_state WHERE schedule_id = ?');
  const anchor = db.prepare(
    `INSERT INTO schedule_state (schedule_id, anchor_at, last_fired_at) VALUES (?, ?, NULL)
     ON CONFLICT (schedule_id) DO NOTHING`,
  );
  const fired = db.prepare(
    `INSERT INTO schedule_state (schedule_id, anchor_at, last_fired_at) VALUES (?, ?, ?)
     ON CONFLICT (schedule_id) DO UPDATE SET last_fired_at = excluded.last_fired_at`,
  );
  return {
    get(scheduleId) {
      const row = read.get(scheduleId);
      if (!row) return null;
      return { anchorAt: text(row, 'anchor_at'), lastFiredAt: textOrNull(row, 'last_fired_at') };
    },
    anchor(scheduleId, at) {
      anchor.run(scheduleId, at);
    },
    markFired(scheduleId, at) {
      fired.run(scheduleId, at, at);
    },
  };
}
