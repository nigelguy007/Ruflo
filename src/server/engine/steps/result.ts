import { z } from 'zod';
import type { StepResult } from '../../ports.js';

const LABEL_LENGTH = 200;
const TEXT_LENGTH = 4_000;
const MAX_ITEMS = 50;

const clipped = (max: number): z.ZodType<string> => z.string().transform((value) => value.slice(0, max));

/**
 * What an executor hands back is ultimately model output, so it is checked and
 * clipped before anything is stored or shown.
 */
export const stepResultSchema: z.ZodType<StepResult> = z.object({
  ok: z.boolean(),
  summary: clipped(TEXT_LENGTH),
  artifacts: z
    .array(
      z.object({
        kind: z.enum(['pr', 'diff', 'log', 'url']),
        label: clipped(LABEL_LENGTH),
        value: clipped(TEXT_LENGTH),
      }),
    )
    .max(MAX_ITEMS),
  claims: z
    .array(
      z.object({
        label: clipped(LABEL_LENGTH),
        detail: clipped(TEXT_LENGTH),
        ok: z.boolean().nullable(),
      }),
    )
    .max(MAX_ITEMS),
  costUsd: z.number().nonnegative().optional(),
});
