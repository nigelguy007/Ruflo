import { useEffect, useState } from 'react';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DAY_MS = DAY;

const HASH_PREFIX_LENGTH = 8;

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const fullFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'long',
});

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso: string | null | undefined, now: number): string {
  const ms = toMs(iso);
  if (ms === null) return 'unknown';
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 45 * SECOND) return 'just now';
  if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))} min ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)} h ago`;
  return `${Math.round(elapsed / DAY)} d ago`;
}

/** "42s", "3m 12s", "1h 04m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Elapsed time between two timestamps; an open end runs up to `now`. */
export function durationBetween(
  start: string | null | undefined,
  end: string | null | undefined,
  now: number,
): string | null {
  const from = toMs(start);
  if (from === null) return null;
  return formatDuration((toMs(end) ?? now) - from);
}

export function formatClock(iso: string): string {
  const ms = toMs(iso);
  return ms === null ? iso : clockFormat.format(ms);
}

export function formatDateTime(iso: string | null | undefined): string {
  const ms = toMs(iso);
  return ms === null ? 'not yet' : dateTimeFormat.format(ms);
}

export function formatFull(iso: string | null | undefined): string {
  const ms = toMs(iso);
  return ms === null ? '' : fullFormat.format(ms);
}

export function isWithin(iso: string | null | undefined, windowMs: number, now: number): boolean {
  const ms = toMs(iso);
  return ms !== null && now - ms <= windowMs;
}

export function shortHash(hash: string): string {
  return hash.slice(0, HASH_PREFIX_LENGTH);
}

/** Returns the URL only when it is plain http(s); anything else is shown as text. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function minutesLabel(minutes: number): string {
  if (minutes === 0) return 'off';
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** A clock that re-renders its caller every `intervalMs`. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
