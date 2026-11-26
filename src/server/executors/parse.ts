import { z } from 'zod';
import type { Artifact } from '../../shared/types.js';
import type { Claim, StepResult } from '../ports.js';

/**
 * Turns whatever a command-line session printed into a StepResult. Sessions
 * are asked to end with one fenced JSON block, but nothing here assumes they
 * did: every stage falls back to something a person can still read.
 */

const MAX_SUMMARY = 1_200;
const MAX_FALLBACK_SUMMARY = 600;
const MAX_LABEL = 200;
const MAX_DETAIL = 1_000;
const MAX_VALUE = 2_000;
const MAX_ITEMS = 20;
const MAX_BRACE_ATTEMPTS = 200;

const clipped = (max: number): z.ZodType<string> =>
  z
    .string()
    .trim()
    .min(1)
    .transform((text) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`));

const artifactSchema = z.object({
  kind: z.enum(['pr', 'diff', 'log', 'url']).catch('log'),
  label: clipped(MAX_LABEL),
  value: clipped(MAX_VALUE),
});

const claimSchema = z.object({
  label: clipped(MAX_LABEL),
  detail: clipped(MAX_DETAIL),
  ok: z.boolean().nullable().catch(null),
});

const finalBlockSchema = z.object({
  summary: clipped(MAX_SUMMARY),
  artifacts: z.array(z.unknown()).catch([]),
  claims: z.array(z.unknown()).catch([]),
});

/** Claude's `--output-format json` result object; every field but `result` is optional. */
const claudeResultSchema = z.object({
  result: z.string(),
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
});

export interface SessionText {
  /** The session's final message. */
  text: string;
  /** The harness itself reported a failure, independent of the exit code. */
  reportedError: boolean;
  costUsd?: number;
}

export interface SessionEnd {
  /** For example "Claude" or "Codex"; used in fallback summaries. */
  label: string;
  exitCode: number | null;
  stderr: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Plain stdout: the whole thing is the final message. */
export function readPlainOutput(stdout: string): SessionText {
  return { text: stdout, reportedError: false };
}

/**
 * Claude prints one JSON object (or, in verbose mode, an array whose last
 * `result` entry is that object). Anything else is treated as plain text.
 */
export function readClaudeOutput(stdout: string): SessionText {
  const parsed = parseJson(stdout.trim());
  const candidate = Array.isArray(parsed)
    ? parsed.findLast((entry) => isPlainObject(entry) && entry.type === 'result')
    : parsed;
  const envelope = claudeResultSchema.safeParse(candidate);
  if (!envelope.success) return readPlainOutput(stdout);
  return {
    text: envelope.data.result,
    reportedError: envelope.data.is_error === true,
    costUsd: envelope.data.total_cost_usd,
  };
}

/** The last JSON object in `text`: fenced blocks first, then any trailing `{…}`. */
export function findLastJsonObject(text: string): Record<string, unknown> | undefined {
  const fences = [...text.matchAll(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)```/g)];
  for (const fence of fences.reverse()) {
    const value = parseJson(fence[1] ?? '');
    if (isPlainObject(value)) return value;
  }

  const end = text.lastIndexOf('}');
  let start = end;
  for (let attempt = 0; attempt < MAX_BRACE_ATTEMPTS && start > 0; attempt += 1) {
    start = text.lastIndexOf('{', start - 1);
    if (start < 0) break;
    const value = parseJson(text.slice(start, end + 1));
    if (isPlainObject(value)) return value;
  }
  return undefined;
}

function validItems<T>(items: unknown[], schema: z.ZodType<T>): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, MAX_ITEMS);
}

function fallbackSummary(text: string, end: SessionEnd): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length > 0) {
    return flat.length <= MAX_FALLBACK_SUMMARY ? flat : `${flat.slice(0, MAX_FALLBACK_SUMMARY - 1)}…`;
  }
  const code = end.exitCode === null ? 'was killed' : `exited with code ${end.exitCode}`;
  const errors = end.stderr.replace(/\s+/g, ' ').trim().slice(-300);
  return errors.length > 0
    ? `The ${end.label} session ${code} and printed no result. Last error output: ${errors}`
    : `The ${end.label} session ${code} and printed no result.`;
}

/** Build the StepResult for a finished session. `ok` never trusts the session's own word. */
export function toStepResult(session: SessionText, end: SessionEnd): StepResult {
  const ok = end.exitCode === 0 && !session.reportedError;
  const cost = session.costUsd === undefined ? {} : { costUsd: session.costUsd };
  const block = finalBlockSchema.safeParse(findLastJsonObject(session.text));

  if (!block.success) {
    return { ok, summary: fallbackSummary(session.text, end), artifacts: [], claims: [], ...cost };
  }
  const artifacts: Artifact[] = validItems(block.data.artifacts, artifactSchema);
  const claims: Claim[] = validItems(block.data.claims, claimSchema);
  return { ok, summary: block.data.summary, artifacts, claims, ...cost };
}
