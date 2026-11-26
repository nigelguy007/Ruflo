import type { Harness } from '../../shared/types.js';
import type { Claim, Executor, StepContext, StepResult } from '../ports.js';
import { delay } from './abort.js';
import { scriptFor } from './scripts/index.js';

/**
 * The scripted executor behind simulate mode. It starts no process and touches
 * no file: the same step, operator and signal always produce the same result,
 * after a pause long enough for a person to watch the run unfold.
 */

const MAX_TITLE_IN_SENTENCE = 120;
const MAX_NOTE_IN_CLAIM = 140;

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Shows the memory layer at work: what this operator recalled before starting. */
function recalledClaim(ctx: StepContext): Claim[] {
  const closest = ctx.recalled[0];
  if (closest === undefined) return [];
  const count = ctx.recalled.length;
  return [
    {
      label: 'Recalled memory',
      detail: `${count} earlier note${count === 1 ? '' : 's'} looked related; the closest was "${shorten(closest.text, MAX_NOTE_IN_CLAIM)}".`,
      ok: null,
    },
  ];
}

export function simulateStep(ctx: StepContext): StepResult {
  const title = shorten(ctx.signal.title, MAX_TITLE_IN_SENTENCE) || 'this signal';
  const result = scriptFor(ctx.run.playbookId, ctx.step.id)({ title, ctx });
  return { ...result, claims: [...result.claims, ...recalledClaim(ctx)] };
}

export function createSimulatedExecutor(stepDelayMs: number, harness: Harness = 'simulated'): Executor {
  return {
    harness,
    run: async (ctx, abort) => {
      await delay(stepDelayMs, abort);
      return simulateStep(ctx);
    },
  };
}
