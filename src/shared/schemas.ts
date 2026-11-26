import { z } from 'zod';

/**
 * Runtime validation for everything that enters the system from outside:
 * config files on disk and request bodies over HTTP.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes');
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().trim().min(1).max(4000);

export const harnessSchema = z.enum(['simulated', 'claude', 'codex']);
export const severitySchema = z.enum(['info', 'warning', 'error', 'critical']);
export const signalSourceSchema = z.enum(['sentry', 'github', 'schedule', 'manual']);

export const operatorConfigSchema = z.object({
  id,
  name: shortText,
  handle: z.string().regex(/^@[a-z0-9][a-z0-9-]{0,30}$/),
  role: shortText,
  instructions: longText,
  harness: harnessSchema,
});
export type OperatorConfig = z.infer<typeof operatorConfigSchema>;

const stepBase = { id, title: shortText };

export const agentStepSchema = z.object({
  ...stepBase,
  kind: z.literal('agent'),
  operator: id,
  instruction: longText,
  handoffTo: id.optional(),
  retries: z.number().int().min(0).max(3).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

export const commandStepSchema = z.object({
  ...stepBase,
  kind: z.literal('command'),
  run: z.array(z.string().min(1).max(500)).min(1).max(40),
  expectExit: z.number().int().min(0).max(255).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

export const gateStepSchema = z.object({
  ...stepBase,
  kind: z.literal('gate'),
  question: shortText,
  onReject: z.enum(['stop', 'continue']),
});

export const stepSchema = z.discriminatedUnion('kind', [
  agentStepSchema,
  commandStepSchema,
  gateStepSchema,
]);

export const budgetSchema = z.object({
  maxMinutes: z.number().int().min(1).max(720),
  maxAgentSteps: z.number().int().min(1).max(50),
  maxHandoffs: z.number().int().min(0).max(20),
});

export const playbookSchema = z
  .object({
    id,
    name: shortText,
    description: longText,
    version: z.number().int().min(1),
    budget: budgetSchema,
    steps: z.array(stepSchema).min(1).max(40),
  })
  .refine((p) => new Set(p.steps.map((s) => s.id)).size === p.steps.length, {
    message: 'step ids must be unique within a playbook',
  });

export const watchSchema = z.object({
  id,
  name: shortText,
  source: signalSourceSchema,
  kinds: z.array(z.string().min(1).max(80)).max(20),
  match: z.record(z.string().min(1).max(120), z.string().max(200)),
  playbookId: id,
  enabled: z.boolean(),
  dedupeMinutes: z.number().int().min(0).max(10080),
});

export const scheduleSchema = z
  .object({
    id,
    name: shortText,
    playbookId: id,
    enabled: z.boolean(),
    everyMinutes: z.number().int().min(1).max(10080).nullable(),
    dailyAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in UTC')
      .nullable(),
  })
  .refine((s) => (s.everyMinutes === null) !== (s.dailyAt === null), {
    message: 'set exactly one of everyMinutes or dailyAt',
  });

export const operatorsFileSchema = z.array(operatorConfigSchema).min(1).max(50);
export const watchesFileSchema = z.array(watchSchema).max(200);
export const schedulesFileSchema = z.array(scheduleSchema).max(200);

// ── Request bodies ───────────────────────────────────────────────────────────

export const manualSignalSchema = z.object({
  title: shortText,
  kind: z
    .string()
    .regex(/^[a-z0-9_.-]{1,80}$/)
    .optional(),
  severity: severitySchema.optional(),
  fingerprint: z.string().trim().min(1).max(200).optional(),
  url: z.url({ protocol: /^https?$/ }).max(2000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  playbookId: id.optional(),
});

export const decisionInputSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  note: z.string().trim().max(2000).optional(),
});

export const watchPatchSchema = z.object({ enabled: z.boolean() });
export const settingsPatchSchema = z.object({ paused: z.boolean() });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().max(40).optional(),
});
