import type { Watch } from '../../shared/types.js';
import type { NormalisedSignal } from '../ports.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a dotted path such as "repository.name" out of a payload. Only own
 * properties are followed, so a path can never reach into a prototype.
 */
export function readPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const key of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Exact match against a string filter. Numbers and booleans compare by their text form. */
function matchesValue(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string') return actual === expected;
  if (typeof actual === 'number' || typeof actual === 'boolean') return String(actual) === expected;
  return false;
}

/** Whether a signal is one this watch accepts: same source, an accepted kind and every filter equal. */
export function watchMatches(watch: Watch, signal: NormalisedSignal): boolean {
  if (!watch.enabled || watch.source !== signal.source) return false;
  if (watch.kinds.length > 0 && !watch.kinds.includes(signal.kind)) return false;
  return Object.entries(watch.match).every(([path, expected]) =>
    matchesValue(readPath(signal.payload, path), expected),
  );
}

/** Matching watches, at most one per playbook: the first one listed wins. */
export function matchWatches(watches: readonly Watch[], signal: NormalisedSignal): Watch[] {
  const playbooks = new Set<string>();
  return watches.filter((watch) => {
    if (playbooks.has(watch.playbookId) || !watchMatches(watch, signal)) return false;
    playbooks.add(watch.playbookId);
    return true;
  });
}
