import { createHash } from 'node:crypto';
import type { Id, LedgerCheck, TimelineEvent, TimelineKind } from '../../shared/types.js';
import type { Store } from '../db/index.js';
import { storableText } from '../db/text.js';
import type { EventBus } from './bus.js';
import { clipText } from './text.js';
import { iso } from './time.js';
import type { Clock, IdGenerator } from './time.js';

/** The `prevHash` of the very first entry. */
export const GENESIS_HASH = '0'.repeat(64);
const MAX_TEXT_LENGTH = 8_000;

/** The fields of an entry that its hash covers. */
export type LedgerBody = Pick<
  TimelineEvent,
  'seq' | 'id' | 'runId' | 'at' | 'actor' | 'kind' | 'text' | 'mentions' | 'data'
>;

export interface LedgerInput {
  runId: Id;
  /** Operator id, "system" or "human". */
  actor: string;
  kind: TimelineKind;
  text: string;
  mentions?: Id[];
  data?: Record<string, unknown> | null;
}

export interface Ledger {
  append(input: LedgerInput): TimelineEvent;
  verify(): LedgerCheck;
}

/** JSON with object keys in sorted order and no whitespace, so equal values always serialise equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function hashEntry(prevHash: string, entry: LedgerBody): string {
  const body: LedgerBody = {
    seq: entry.seq,
    id: entry.id,
    runId: entry.runId,
    at: entry.at,
    actor: entry.actor,
    kind: entry.kind,
    text: entry.text,
    mentions: entry.mentions,
    data: entry.data,
  };
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(body)}`).digest('hex');
}

/** Reduces `data` to exactly what survives storage as JSON, so the hash matches after a reload. */
function storable(data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  const parsed: unknown = JSON.parse(JSON.stringify(data));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : null;
}

export function createLedger(
  store: Store,
  bus: EventBus,
  clock: Clock,
  newId: IdGenerator,
): Ledger {
  function append(input: LedgerInput): TimelineEvent {
    // Reading the tip and inserting happen in one transaction, so the chain cannot fork.
    const event = store.transaction(() => {
      const tip = store.timeline.tip();
      const prevHash = tip?.hash ?? GENESIS_HASH;
      const body: LedgerBody = {
        seq: (tip?.seq ?? 0) + 1,
        id: newId('evt'),
        runId: storableText(input.runId),
        at: iso(clock()),
        actor: storableText(input.actor),
        kind: input.kind,
        // Hashed and stored from the same normalised value: SQLite would otherwise change
        // a lone surrogate or cut at a NUL, and verify() would call that tampering.
        text: clipText(input.text, MAX_TEXT_LENGTH),
        mentions: [...(input.mentions ?? [])],
        data: storable(input.data),
      };
      return store.timeline.insert({ ...body, prevHash, hash: hashEntry(prevHash, body) });
    });
    bus.publish({ type: 'timeline.appended', event });
    return event;
  }

  function verify(): LedgerCheck {
    let prevHash = GENESIS_HASH;
    let checked = 0;
    for (const { seq, event } of store.timeline.walk()) {
      const intact =
        event !== null && event.prevHash === prevHash && hashEntry(prevHash, event) === event.hash;
      if (!intact) return { ok: false, checked, brokenAt: seq };
      prevHash = event.hash;
      checked += 1;
    }
    return { ok: true, checked, brokenAt: null };
  }

  return { append, verify };
}
