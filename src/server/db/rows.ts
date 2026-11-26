import type { SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';

/** One row as node:sqlite returns it. */
export type Row = Record<string, SQLOutputValue>;

/**
 * Typed column readers. A stored value of the wrong shape means the database
 * was edited by hand or is corrupt, so these fail loudly instead of guessing.
 */
export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`Column ${column} is not text.`);
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Column ${column} is not text.`);
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') throw new Error(`Column ${column} is not a number.`);
  return value;
}

export function boolOrNull(row: Row, column: string): boolean | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return integer(row, column) !== 0;
}

/** Narrows a stored string to one of a fixed set of literals. */
export function oneOf<T extends string>(row: Row, column: string, allowed: readonly T[]): T {
  const value = text(row, column);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`Column ${column} holds an unknown value.`);
  return match;
}

/** Parses a JSON column and validates it against `schema`. */
export function json<T>(row: Row, column: string, schema: z.ZodType<T>): T {
  const parsed: unknown = JSON.parse(text(row, column));
  return schema.parse(parsed);
}

export function jsonOrNull<T>(row: Row, column: string, schema: z.ZodType<T>): T | null {
  return row[column] === null || row[column] === undefined ? null : json(row, column, schema);
}

export const recordSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());
export const stringListSchema: z.ZodType<string[]> = z.array(z.string());

export function toFlag(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

/** `?, ?, ?` for an IN (...) clause with `count` bound values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
