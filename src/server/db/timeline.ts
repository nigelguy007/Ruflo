import type { DatabaseSync } from 'node:sqlite';
import type { Id, TimelineEvent, TimelineKind } from '../../shared/types.js';
import { createStatementCache } from './database.js';
import type { Prepare } from './database.js';
import { integer, json, jsonOrNull, oneOf, recordSchema, stringListSchema, text } from './rows.js';
import type { Row } from './rows.js';
import { isStorableText } from './text.js';

const KINDS: readonly TimelineKind[] = [
  'signal',
  'note',
  'handoff',
  'artifact',
  'command',
  'gate_opened',
  'gate_resolved',
  'error',
  'system',
];

const PAGE_SIZE = 500;

export interface LedgerTip {
  seq: number;
  hash: string;
}

export interface LedgerRow {
  seq: number;
  /** null when the stored row is no longer readable. */
  event: TimelineEvent | null;
}

function toEvent(row: Row): TimelineEvent {
  return {
    seq: integer(row, 'seq'),
    id: text(row, 'id'),
    runId: text(row, 'run_id'),
    at: text(row, 'at'),
    actor: text(row, 'actor'),
    kind: oneOf(row, 'kind', KINDS),
    text: text(row, 'text'),
    mentions: json(row, 'mentions', stringListSchema),
    data: jsonOrNull(row, 'data', recordSchema),
    prevHash: text(row, 'prev_hash'),
    hash: text(row, 'hash'),
  };
}

/** Storage for the ledger. Insert and read only: there is no update or delete. */
export class TimelineRepository {
  private readonly prepare: Prepare;

  constructor(db: DatabaseSync) {
    this.prepare = createStatementCache(db);
  }

  /** The last entry's position and hash, or null for an empty ledger. */
  tip(): LedgerTip | null {
    const row = this.prepare('SELECT seq, hash FROM timeline ORDER BY seq DESC LIMIT 1').get();
    return row ? { seq: integer(row, 'seq'), hash: text(row, 'hash') } : null;
  }

  /**
   * The hash covers the exact strings passed in, so they must be ones SQLite
   * keeps as given. The ledger makes them so; this refuses anything else rather
   * than store a row that `verify()` would later call tampered.
   */
  insert(event: TimelineEvent): TimelineEvent {
    if (![event.runId, event.actor, event.text].every(isStorableText)) {
      throw new Error('Ledger text must be storable as given before it is hashed.');
    }
    this.prepare(
      `INSERT INTO timeline (seq, id, run_id, at, actor, kind, text, mentions, data, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.seq,
      event.id,
      event.runId,
      event.at,
      event.actor,
      event.kind,
      event.text,
      JSON.stringify(event.mentions),
      event.data === null ? null : JSON.stringify(event.data),
      event.prevHash,
      event.hash,
    );
    return event;
  }

  /** Oldest first. */
  forRun(runId: Id): TimelineEvent[] {
    return this.prepare('SELECT * FROM timeline WHERE run_id = ? ORDER BY seq').all(runId).map(toEvent);
  }

  count(): number {
    const row = this.prepare('SELECT COUNT(*) AS n FROM timeline').get();
    return row ? integer(row, 'n') : 0;
  }

  /**
   * Walks the whole ledger in order, one page at a time, without holding it all
   * in memory. A row that can no longer be decoded is yielded with `event: null`
   * so the caller can report where the ledger broke instead of crashing.
   */
  *walk(): Generator<LedgerRow> {
    const page = this.prepare('SELECT * FROM timeline WHERE seq > ? ORDER BY seq LIMIT ?');
    let after = 0;
    for (;;) {
      const rows = page.all(after, PAGE_SIZE);
      for (const row of rows) {
        after = integer(row, 'seq');
        yield { seq: after, event: decode(row) };
      }
      if (rows.length < PAGE_SIZE) return;
    }
  }
}

function decode(row: Row): TimelineEvent | null {
  try {
    return toEvent(row);
  } catch {
    return null;
  }
}
