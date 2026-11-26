import type { SignalAdapter } from '../ports.js';
import { githubAdapter } from './github.js';
import { sentryAdapter } from './sentry.js';

/**
 * Inbound webhook adapters, one per provider. Each verifies the provider's
 * HMAC signature over the raw body in constant time and normalises the
 * deliveries Switchyard acts on; everything else normalises to null.
 */
export const signalAdapters: Record<'sentry' | 'github', SignalAdapter> = {
  sentry: sentryAdapter,
  github: githubAdapter,
};
