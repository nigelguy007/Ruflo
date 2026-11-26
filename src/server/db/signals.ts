import type { DatabaseSync } from 'node:sqlite';
import type { Id, IsoTime, Severity, Signal, SignalSource } from '../../shared/types.js';
import { json, oneOf, recordSchema, text, textOrNull } from './rows.js';
import type { Row } from './rows.js';
import { storableText, storableTextOrNull } from './text.js';

const SOURCES: readonly SignalSource[] = ['sentry', 'github', 'schedule', 'manual'];
const SEVERITIES: readonly Severity[] = ['info', 'warning', 'error', 'critical'];

export interface SignalRepository {
  /** Returns the signal as stored: free text with anything SQLite cannot keep replaced by U+FFFD. */
  insert(signal: Signal): Signal;
  get(id: Id): Signal | null;
  /** Newest first. */
  list(limit: number): Signal[];
  count(): number;
  lastReceivedAt(): IsoTime | null;
}

function toSignal(row: Row): Signal {
  return {
    id: text(row, 'id'),
    source: oneOf(row, 'source', SOURCES),
    kind: text(row, 'kind'),
    title: text(row, 'title'),
    fingerprint: text(row, 'fingerprint'),
    url: textOrNull(row, 'url'),
    severity: oneOf(row, 'severity', SEVERITIES),
    payload: json(row, 'payload', recordSchema),
    receivedAt: text(row, 'received_at'),
  };
}

export function createSignalRepository(db: DatabaseSync): SignalRepository {
  const insert = db.prepare(
    `INSERT INTO signals (id, source, kind, title, fingerprint, url, severity, payload, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM signals WHERE id = ?');
  const newest = db.prepare('SELECT * FROM signals ORDER BY seq DESC LIMIT ?');
  const total = db.prepare('SELECT COUNT(*) AS n FROM signals');
  const last = db.prepare('SELECT received_at FROM signals ORDER BY seq DESC LIMIT 1');

  return {
    insert(input) {
      // Hand back what the database holds, so callers never work from text it would have changed.
      const signal: Signal = {
        ...input,
        kind: storableText(input.kind),
        title: storableText(input.title),
        fingerprint: storableText(input.fingerprint),
        url: storableTextOrNull(input.url),
      };
      insert.run(
        signal.id,
        signal.source,
        signal.kind,
        signal.title,
        signal.fingerprint,
        signal.url,
        signal.severity,
        JSON.stringify(signal.payload),
        signal.receivedAt,
      );
      return signal;
    },
    get(id) {
      const row = byId.get(id);
      return row ? toSignal(row) : null;
    },
    list(limit) {
      return newest.all(limit).map(toSignal);
    },
    count() {
      const row = total.get();
      return row ? Number(row['n']) : 0;
    },
    lastReceivedAt() {
      const row = last.get();
      return row ? text(row, 'received_at') : null;
    },
  };
}
