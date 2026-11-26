import { z } from 'zod';
import type { MemoryHit, RouteAdvice } from '../ports.js';

/**
 * Parsers for the Ruflo MCP tools Switchyard calls. Every shape here was
 * observed against ruflo 3.80.8; anything else is reported as an error so the
 * caller can fall back instead of trusting a guess.
 */

const MAX_ERROR_TEXT = 200;
const MAX_REASON = 300;
const CODEMOD_MARKER = '[CODEMOD_AVAILABLE]';
/** memory_search shortens values longer than this to a preview ending in "...". */
const PREVIEW_SUFFIX = '...';

export class RufloResponseError extends Error {
  override readonly name = 'RufloResponseError';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** `{ success: false, error }` is how Ruflo handlers report invalid input. */
const handlerFailureSchema = z.object({ success: z.literal(false), error: z.string().optional() });

/** The JSON document inside an MCP tool result, or a RufloResponseError. */
export function toolJson(result: unknown): unknown {
  const parsed = toolResultSchema.safeParse(result);
  if (!parsed.success) throw new RufloResponseError('unexpected tool result shape');
  const text = parsed.data.content.find((item) => item.type === 'text')?.text;
  if (parsed.data.isError === true) {
    throw new RufloResponseError(`tool reported an error: ${clip(text ?? 'no detail', MAX_ERROR_TEXT)}`);
  }
  if (text === undefined) throw new RufloResponseError('tool result has no text content');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RufloResponseError('tool result is not JSON');
  }
  const failure = handlerFailureSchema.safeParse(value);
  if (failure.success) {
    throw new RufloResponseError(`tool refused the call: ${clip(failure.data.error ?? 'no detail', MAX_ERROR_TEXT)}`);
  }
  return value;
}

// ── memory_store ─────────────────────────────────────────────────────────────

const storeSchema = z.object({ success: z.literal(true), stored: z.boolean().optional() });

/** Throws unless Ruflo confirmed the entry was stored. */
export function assertStored(value: unknown): void {
  const parsed = storeSchema.safeParse(value);
  if (!parsed.success) throw new RufloResponseError('memory_store did not confirm success');
  if (parsed.data.stored === false) throw new RufloResponseError('memory_store reports the entry was not stored');
}

// ── memory_search and memory_retrieve ────────────────────────────────────────

const searchSchema = z.object({ results: z.array(z.unknown()) });

const searchHitSchema = z.object({
  key: z.string().min(1),
  namespace: z.string().optional(),
  value: z.unknown(),
  similarity: z.number(),
});

export interface SearchHit extends MemoryHit {
  /** true when `text` is Ruflo's shortened preview rather than the stored value. */
  preview: boolean;
}

function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value : null;
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function clampScore(score: number): number {
  return Math.min(1, Math.max(0, score));
}

/**
 * Hits from a memory_search answer, closest first. Entries from any other
 * namespace are dropped, so one operator never sees another operator's notes
 * even if the server ignored the namespace filter.
 */
export function parseSearchHits(value: unknown, namespace: string, limit: number): SearchHit[] {
  const parsed = searchSchema.safeParse(value);
  if (!parsed.success) throw new RufloResponseError('memory_search answer has no results list');
  const hits = parsed.data.results.flatMap((item): SearchHit[] => {
    const hit = searchHitSchema.safeParse(item);
    if (!hit.success || (hit.data.namespace !== undefined && hit.data.namespace !== namespace)) return [];
    const text = valueText(hit.data.value);
    if (text === null) return [];
    const score = clampScore(hit.data.similarity);
    return [{ key: hit.data.key, text, score, preview: text.endsWith(PREVIEW_SUFFIX) }];
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}

const retrieveSchema = z.object({ found: z.boolean().optional(), value: z.unknown() });

/** The full stored value from a memory_retrieve answer, or null when it was not found. */
export function parseRetrievedText(value: unknown): string | null {
  const parsed = retrieveSchema.safeParse(value);
  if (!parsed.success || parsed.data.found === false) return null;
  return valueText(parsed.data.value);
}

// ── hooks_route ──────────────────────────────────────────────────────────────

const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const routeSchema = z.object({
  tier: tierSchema.optional().catch(undefined),
  modelRouting: z
    .object({ tier: tierSchema.optional().catch(undefined), model: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  primaryAgent: z
    .object({ type: z.string(), confidence: z.number().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  estimatedMetrics: z
    .object({ complexity: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

type RouteAnswer = z.infer<typeof routeSchema>;

function suggestion(answer: RouteAnswer): string {
  const agent = answer.primaryAgent;
  if (agent === undefined) return 'Ruflo gave no agent suggestion';
  const confidence = agent.confidence === undefined ? '' : `, ${Math.round(agent.confidence * 100)}% confidence`;
  const complexity = answer.estimatedMetrics?.complexity;
  const detail = complexity === undefined ? confidence : `${confidence}, ${complexity} complexity`;
  return `Ruflo suggests a ${agent.type} agent${detail}`;
}

/**
 * hooks_route (3.80.8) answers with an agent suggestion and no model tier. A
 * tier is used only when Ruflo states one, at the top level or under
 * `modelRouting` as hooks_pre-task does, or marks a deterministic codemod;
 * otherwise the advice stays at tier 3, the safe default.
 */
export function parseRouteAdvice(value: unknown, rawText: string): RouteAdvice {
  const parsed = routeSchema.safeParse(value);
  if (!parsed.success) throw new RufloResponseError('hooks_route answer is not an object');
  const answer = parsed.data;
  const stated = answer.tier ?? answer.modelRouting?.tier;
  const lead = suggestion(answer);
  if (stated !== undefined) {
    return { tier: stated, reason: clip(`${lead}; Ruflo recommends tier ${stated}.`, MAX_REASON) };
  }
  if (rawText.includes(CODEMOD_MARKER)) {
    return { tier: 1, reason: clip(`${lead}; a deterministic codemod can apply this change.`, MAX_REASON) };
  }
  return { tier: 3, reason: clip(`${lead}; it named no model tier, so the large model is used.`, MAX_REASON) };
}

/** The raw text of a tool result, for markers that live outside the JSON fields. */
export function toolText(result: unknown): string {
  const parsed = toolResultSchema.safeParse(result);
  if (!parsed.success) return '';
  return parsed.data.content.flatMap((item) => (item.text === undefined ? [] : [item.text])).join('\n');
}
