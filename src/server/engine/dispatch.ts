import type { Id, Playbook, Run, Signal, SignalResult, Watch } from '../../shared/types.js';
import type { NormalisedSignal } from '../ports.js';
import { SYSTEM_ACTOR } from './context.js';
import type { EngineContext } from './context.js';
import { EngineError } from './errors.js';
import { matchWatches } from './matching.js';
import { saveRun } from './run-state.js';
import { iso, MINUTE_MS } from './time.js';

export interface DispatchOptions {
  /** Skip watch matching and start this playbook directly. */
  playbookId?: Id;
}

/** The catalog's watches with the console's enabled-overrides applied. */
export function listWatches(ctx: EngineContext): Watch[] {
  const overrides = ctx.store.watchOverrides.all();
  return ctx.catalog.watches.map((watch) => {
    const enabled = overrides.get(watch.id);
    return enabled === undefined ? watch : { ...watch, enabled };
  });
}

export function setWatchEnabled(ctx: EngineContext, id: Id, enabled: boolean): Watch {
  const watch = ctx.catalog.watch(id);
  if (!watch) throw new EngineError('not_found', `Watch ${id} does not exist.`);
  ctx.store.watchOverrides.set(id, enabled);
  return { ...watch, enabled };
}

function storeSignal(ctx: EngineContext, normalised: NormalisedSignal): Signal {
  return ctx.store.signals.insert({
    id: ctx.newId('sig'),
    source: normalised.source,
    kind: normalised.kind,
    title: normalised.title,
    fingerprint: normalised.fingerprint,
    url: normalised.url,
    severity: normalised.severity,
    payload: normalised.payload,
    receivedAt: iso(ctx.clock()),
  });
}

function startRun(ctx: EngineContext, signal: Signal, playbook: Playbook, watch: Watch | null): Run {
  const run = ctx.store.runs.insert({
    id: ctx.newId('run'),
    playbook,
    signalId: signal.id,
    fingerprint: signal.fingerprint,
    title: signal.title,
    createdAt: iso(ctx.clock()),
  });
  ctx.ledger.append({
    runId: run.id,
    actor: SYSTEM_ACTOR,
    kind: 'signal',
    text: `Signal from ${signal.source} (${signal.kind}): ${signal.title}`,
    data: {
      signalId: signal.id,
      source: signal.source,
      kind: signal.kind,
      severity: signal.severity,
      url: signal.url,
      playbookId: playbook.id,
      watchId: watch?.id ?? null,
    },
  });
  ctx.bus.publish({ type: 'run.updated', run });
  ctx.enqueue(run.id);
  return run;
}

/** An active run that already covers this fingerprint, if the watch de-duplicates at all. */
function findDuplicate(ctx: EngineContext, watch: Watch, signal: Signal): Run | null {
  if (watch.dedupeMinutes <= 0) return null;
  const since = new Date(ctx.clock().getTime() - watch.dedupeMinutes * MINUTE_MS);
  return ctx.store.runs.findActiveDuplicate(watch.playbookId, signal.fingerprint, iso(since));
}

function joinRun(ctx: EngineContext, run: Run, signal: Signal): Id {
  saveRun(ctx, run.id, { addDuplicateSignals: 1 });
  ctx.ledger.append({
    runId: run.id,
    actor: SYSTEM_ACTOR,
    kind: 'system',
    text: `Another signal for the same problem arrived ("${signal.title}") and was folded into this run.`,
    data: { signalId: signal.id },
  });
  return run.id;
}

/**
 * Takes a signal in: stores it, then either starts the named playbook or
 * starts one run per matching watch. A signal whose fingerprint is already
 * covered by an active run joins that run instead of starting another.
 */
export function dispatch(
  ctx: EngineContext,
  normalised: NormalisedSignal,
  opts: DispatchOptions = {},
): SignalResult {
  const direct = opts.playbookId === undefined ? null : ctx.catalog.playbook(opts.playbookId);
  if (opts.playbookId !== undefined && direct === null) {
    throw new EngineError('bad_request', `Playbook "${opts.playbookId}" does not exist.`);
  }
  return ctx.store.transaction(() => {
    const signal = storeSignal(ctx, normalised);
    ctx.bus.publish({ type: 'signal.received', signal });
    if (direct !== null) return { signal, runs: [startRun(ctx, signal, direct, null)], joined: [] };

    const runs: Run[] = [];
    const joined: Id[] = [];
    for (const watch of matchWatches(listWatches(ctx), normalised)) {
      const playbook = ctx.catalog.playbook(watch.playbookId);
      if (playbook === null) continue;
      const duplicate = findDuplicate(ctx, watch, signal);
      if (duplicate) joined.push(joinRun(ctx, duplicate, signal));
      else runs.push(startRun(ctx, signal, playbook, watch));
    }
    return { signal, runs, joined };
  });
}
