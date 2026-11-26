import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import {
  decisionInputSchema,
  manualSignalSchema,
  settingsPatchSchema,
  watchPatchSchema,
} from '../../shared/schemas.js';
import type { CoordinationKind, Health, Mode } from '../../shared/types.js';
import type { Engine } from '../engine/index.js';
import type { NormalisedSignal } from '../ports.js';
import { ok } from './envelope.js';
import { decisionStatus, pathId, readJson, readListQuery, runStatuses } from './input.js';

/** The person answering in the console; there are no user accounts. */
const DECIDED_BY = 'human';
const DEFAULT_MANUAL_KIND = 'manual.run';
const DEFAULT_MANUAL_SEVERITY = 'warning';
const FINGERPRINT_LENGTH = 16;

export interface ApiRouteDeps {
  engine: Engine;
  mode: Mode;
  coordination: CoordinationKind;
  version: string;
}

type ManualInput = z.output<typeof manualSignalSchema>;

/** Two reports of the same title are the same problem unless the sender says otherwise. */
function titleFingerprint(title: string): string {
  const normalised = title.toLowerCase().replace(/\s+/g, ' ').trim();
  const hash = createHash('sha256').update(normalised, 'utf8').digest('hex');
  return `manual:${hash.slice(0, FINGERPRINT_LENGTH)}`;
}

export function manualSignal(input: ManualInput): NormalisedSignal {
  return {
    source: 'manual',
    kind: input.kind ?? DEFAULT_MANUAL_KIND,
    title: input.title,
    fingerprint: input.fingerprint ?? titleFingerprint(input.title),
    url: input.url ?? null,
    severity: input.severity ?? DEFAULT_MANUAL_SEVERITY,
    payload: input.payload ?? {},
  };
}

/** A whole catalog list: nothing is cut, so the limit is the total. */
function whole<T>(c: Context, items: readonly T[]): Response {
  return ok(c, items, { total: items.length, limit: items.length });
}

function registerReads(app: Hono, deps: ApiRouteDeps): void {
  const { engine } = deps;
  app.get('/api/health', (c) => {
    const health: Health = {
      status: 'ok',
      version: deps.version,
      mode: deps.mode,
      paused: engine.settings().paused,
      coordination: deps.coordination,
    };
    return ok(c, health);
  });
  app.get('/api/overview', (c) => ok(c, engine.overview()));
  app.get('/api/operators', (c) => whole(c, engine.operators()));
  app.get('/api/playbooks', (c) => whole(c, engine.playbooks()));
  app.get('/api/watches', (c) => whole(c, engine.watches()));
  app.get('/api/schedules', (c) => whole(c, engine.schedules()));
  app.get('/api/signals', (c) => {
    const { limit } = readListQuery(c);
    const page = engine.signals(limit);
    return ok(c, page.items, { total: page.total, limit });
  });
  app.get('/api/runs', (c) => {
    const query = readListQuery(c);
    const page = engine.runs({ statuses: runStatuses(query.status), limit: query.limit });
    return ok(c, page.items, { total: page.total, limit: query.limit });
  });
  app.get('/api/runs/:id', (c) => ok(c, engine.runDetail(pathId(c, 'Run'))));
  app.get('/api/decisions', (c) => {
    const query = readListQuery(c);
    const page = engine.decisions({ status: decisionStatus(query.status), limit: query.limit });
    return ok(c, page.items, { total: page.total, limit: query.limit });
  });
  app.get('/api/settings', (c) => ok(c, engine.settings()));
  app.get('/api/ledger/verify', (c) => ok(c, engine.verifyLedger()));
}

function registerWrites(app: Hono, deps: ApiRouteDeps): void {
  const { engine } = deps;
  app.patch('/api/watches/:id', async (c) => {
    const id = pathId(c, 'Watch');
    const { enabled } = await readJson(c, watchPatchSchema);
    return ok(c, engine.setWatchEnabled(id, enabled));
  });
  app.post('/api/signals/manual', async (c) => {
    const input = await readJson(c, manualSignalSchema);
    const opts = input.playbookId === undefined ? {} : { playbookId: input.playbookId };
    return ok(c, engine.dispatch(manualSignal(input), opts));
  });
  app.post('/api/runs/:id/cancel', (c) => ok(c, engine.cancel(pathId(c, 'Run'))));
  app.post('/api/decisions/:id', async (c) => {
    const id = pathId(c, 'Decision');
    const input = await readJson(c, decisionInputSchema);
    return ok(c, engine.decide(id, input.verdict, input.note, DECIDED_BY));
  });
  app.put('/api/settings', async (c) => {
    const { paused } = await readJson(c, settingsPatchSchema);
    return ok(c, engine.setPaused(paused));
  });
}

/** Every JSON route in src/shared/api.ts except the webhooks and the event stream. */
export function registerApiRoutes(app: Hono, deps: ApiRouteDeps): void {
  registerReads(app, deps);
  registerWrites(app, deps);
}
