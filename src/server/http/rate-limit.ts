const MINUTE_MS = 60_000;
/** Upper bound on remembered client addresses, so a flood of new addresses cannot grow memory without end. */
export const DEFAULT_MAX_CLIENTS = 10_000;

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Spends one token from `key`'s bucket, or says how long until one is available. */
  take(key: string): RateDecision;
  size(): number;
}

export interface RateLimiterOptions {
  perMinute: number;
  now: () => number;
  maxClients?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per client: holds up to `perMinute` tokens and refills at
 * `perMinute` tokens a minute. The map is kept in least-recently-used order;
 * past `maxClients` the client heard from longest ago is forgotten.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const capacity = options.perMinute;
  const perMs = options.perMinute / MINUTE_MS;
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const buckets = new Map<string, Bucket>();

  function current(key: string, now: number): Bucket {
    const known = buckets.get(key);
    if (known === undefined) return { tokens: capacity, updatedAt: now };
    buckets.delete(key);
    const elapsed = Math.max(0, now - known.updatedAt);
    return { tokens: Math.min(capacity, known.tokens + elapsed * perMs), updatedAt: now };
  }

  function remember(key: string, bucket: Bucket): void {
    buckets.set(key, bucket);
    while (buckets.size > maxClients) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) return;
      buckets.delete(oldest.value);
    }
  }

  return {
    take(key) {
      const now = options.now();
      const bucket = current(key, now);
      if (bucket.tokens >= 1) {
        remember(key, { tokens: bucket.tokens - 1, updatedAt: now });
        return { allowed: true };
      }
      remember(key, bucket);
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1_000));
      return { allowed: false, retryAfterSeconds };
    },
    size: () => buckets.size,
  };
}
