import type { Id } from '../../shared/types.js';
import type { Coordination, MemoryHit, RouteAdvice } from '../ports.js';

/**
 * In-memory coordination, used when Ruflo is switched off or does not start.
 * Memory is bounded per operator and lost on restart; recall scores entries
 * by how many of the query's keywords they contain.
 */

export const LOCAL_MAX_ENTRIES = 200;
const MAX_TEXT = 4_000;
const MIN_TOKEN_LENGTH = 2;
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with',
]);

export const LOCAL_ROUTE_REASON = 'Local coordination has no router, so the large model is used.';

interface Entry {
  key: string;
  text: string;
  tokens: ReadonlySet<string>;
}

/** Lower-cased words and numbers, without stop words or single characters. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(word)));
}

/** Share of the query's keywords that appear in the entry, 0..1. */
export function overlapScore(query: ReadonlySet<string>, entry: ReadonlySet<string>): number {
  if (query.size === 0) return 0;
  let shared = 0;
  for (const word of query) if (entry.has(word)) shared += 1;
  return shared / query.size;
}

export class LocalCoordination implements Coordination {
  readonly kind = 'local' as const;
  private memory: ReadonlyMap<Id, readonly Entry[]> = new Map();

  constructor(private readonly maxEntries: number = LOCAL_MAX_ENTRIES) {}

  async recall(operatorId: Id, query: string, limit: number): Promise<MemoryHit[]> {
    const wanted = keywords(query);
    const entries = this.memory.get(operatorId) ?? [];
    // Newest first, so equal scores favour the more recent note.
    const scored = [...entries].reverse().flatMap((entry): MemoryHit[] => {
      const score = overlapScore(wanted, entry.tokens);
      return score > 0 ? [{ key: entry.key, text: entry.text, score }] : [];
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
  }

  async remember(operatorId: Id, key: string, text: string, tags: string[]): Promise<void> {
    const stored = text.slice(0, MAX_TEXT);
    const entry: Entry = { key, text: stored, tokens: keywords(`${stored} ${tags.join(' ')}`) };
    const kept = (this.memory.get(operatorId) ?? []).filter((existing) => existing.key !== key);
    const next = new Map(this.memory);
    next.set(operatorId, [...kept, entry].slice(-this.maxEntries));
    this.memory = next;
  }

  async route(_task: string): Promise<RouteAdvice> {
    return { tier: 3, reason: LOCAL_ROUTE_REASON };
  }

  async close(): Promise<void> {
    this.memory = new Map();
  }
}
