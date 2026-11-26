import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createCoordination } from '../../../src/server/coordination/index.js';
import { createLogger } from '../../../src/server/logger.js';
import { makeConfig, makeTempDir } from '../executors/helpers.js';

/**
 * Talks to the real Ruflo MCP server (`npx -y --prefer-offline ruflo@latest mcp start`).
 * Opt in with RUFLO_LIVE=1; it needs npx and either a cached ruflo or the registry.
 * Timings are written to stderr through the server's own JSON logger.
 */
const LIVE = process.env.RUFLO_LIVE === '1';
const LIVE_TIMEOUT_MS = 180_000;

describe.skipIf(!LIVE)('Ruflo, live', () => {
  const temp = makeTempDir();

  afterAll(() => temp.cleanup());

  test(
    'stores, searches and routes against the real server',
    async () => {
      const log = createLogger('ruflo-live');
      const config = makeConfig({ SWITCHYARD_COORDINATION: 'ruflo', SWITCHYARD_DB: join(temp.dir, 'switchyard.db') });
      const operatorId = `live-${randomUUID().slice(0, 8)}`;
      const note = `Production error to shipped fix for "TypeError: cart.total is undefined" ended succeeded. ${randomUUID()}`;
      const timings: Record<string, number> = {};
      const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now();
        const value = await work();
        timings[name] = Date.now() - startedAt;
        return value;
      };

      const memory = await timed('connectMs', () => createCoordination(config, log));
      try {
        expect(memory.kind).toBe('ruflo');
        await timed('rememberMs', () => memory.remember(operatorId, 'run:live-1', note, ['error-to-fix', 'succeeded']));
        const hits = await timed('recallMs', () => memory.recall(operatorId, 'TypeError cart.total is undefined', 3));
        const advice = await timed('routeMs', () => memory.route('Fix TypeError: cart.total is undefined in checkout'));
        log.info('live timings', { ...timings, hits: hits.length, tier: advice.tier, reason: advice.reason });

        expect(hits[0]).toMatchObject({ key: 'run:live-1', text: note });
        expect(hits[0]?.score).toBeGreaterThan(0.3);
        expect([1, 2, 3]).toContain(advice.tier);
        expect(advice.reason.length).toBeGreaterThan(0);
      } finally {
        await timed('closeMs', () => memory.close());
        log.info('live close', { closeMs: timings.closeMs });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
