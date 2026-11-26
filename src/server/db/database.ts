import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

export const IN_MEMORY = ':memory:';

/** Opens the database, creating its directory when needed, and brings the schema up to date. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== IN_MEMORY) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  const version = row?.['user_version'];
  return typeof version === 'number' ? version : 0;
}

/** Applies every migration the database has not seen yet, each in its own transaction. */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build understands (${migrations.length}).`,
    );
  }
  migrations.slice(current).forEach((sql, offset) => {
    const target = current + offset + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      // PRAGMA cannot take a bound parameter; `target` is a number we computed.
      db.exec(`PRAGMA user_version = ${target}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export type Prepare = (sql: string) => StatementSync;

/** Prepares each distinct statement once and reuses it. SQL text is always a literal from this codebase. */
export function createStatementCache(db: DatabaseSync): Prepare {
  const cache = new Map<string, StatementSync>();
  return (sql) => {
    const cached = cache.get(sql);
    if (cached) return cached;
    const statement = db.prepare(sql);
    cache.set(sql, statement);
    return statement;
  };
}

/**
 * Runs `work` inside one transaction. Calls nest: only the outermost call
 * begins and commits, so repositories can be composed freely.
 */
export function createTransaction(db: DatabaseSync): <T>(work: () => T) => T {
  let depth = 0;
  return <T>(work: () => T): T => {
    if (depth > 0) return work();
    db.exec('BEGIN IMMEDIATE');
    depth += 1;
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      depth -= 1;
    }
  };
}
