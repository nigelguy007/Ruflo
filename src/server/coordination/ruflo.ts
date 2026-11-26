import type { Id } from '../../shared/types.js';
import { errorMessage } from '../logger.js';
import type { Coordination, Logger, MemoryHit, RouteAdvice } from '../ports.js';
import { assertStored, parseRetrievedText, parseRouteAdvice, parseSearchHits, toolJson, toolText } from './parse.js';
import type { SearchHit } from './parse.js';
import type { ToolSession } from './session.js';

/**
 * Memory and routing backed by the Ruflo MCP server. Coordination is a
 * nicety, so nothing here throws: recall answers [] on any failure, remember
 * logs and drops the note, and route falls back to tier 3 with the reason.
 */

export const CALL_TIMEOUT_MS = 5_000;
/** Ruflo's raw relevance for unrelated notes was about 0.1, for related ones above 0.6. */
const RECALL_THRESHOLD = 0.3;
const MAX_RECALL = 20;
const MAX_REASON_ERROR = 160;
/** Ruflo allows letters, digits, `_`, `-`, `.` and `:` in a namespace; `/` is rejected. */
const NAMESPACE_PREFIX = 'switchyard:';
const NAMESPACE_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export const DISCONNECTED_REASON = 'Ruflo is not connected, so the large model is used.';

/** One namespace per operator, or null for an id Ruflo would reject. */
export function namespaceFor(operatorId: Id): string | null {
  return NAMESPACE_ID.test(operatorId) ? `${NAMESPACE_PREFIX}${operatorId}` : null;
}

interface ToolAnswer {
  json: unknown;
  text: string;
}

export interface RufloCoordinationOptions {
  callTimeoutMs?: number;
  /** Runs once after close, e.g. to remove a temporary data directory. */
  onClosed?: () => void;
}

export class RufloCoordination implements Coordination {
  readonly kind = 'ruflo' as const;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly session: ToolSession,
    private readonly log: Logger,
    private readonly options: RufloCoordinationOptions = {},
  ) {
    this.timeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  async recall(operatorId: Id, query: string, limit: number): Promise<MemoryHit[]> {
    const namespace = namespaceFor(operatorId);
    if (namespace === null) {
      this.log.warn('Ruflo recall skipped: the operator id is not a valid namespace', { operatorId });
      return [];
    }
    const wanted = Math.min(Math.floor(limit), MAX_RECALL);
    if (!(wanted > 0) || !this.session.connected) return [];
    const deadline = Date.now() + this.timeoutMs;
    try {
      const args = { query, namespace, limit: wanted, threshold: RECALL_THRESHOLD };
      const answer = await this.call('memory_search', args, deadline);
      return await this.withFullText(parseSearchHits(answer.json, namespace, wanted), namespace, deadline);
    } catch (error) {
      this.log.warn('Ruflo recall failed; continuing without memory', { operatorId, error: errorMessage(error) });
      return [];
    }
  }

  async remember(operatorId: Id, key: string, text: string, tags: string[]): Promise<void> {
    const namespace = namespaceFor(operatorId);
    if (namespace === null) {
      this.log.warn('Ruflo remember skipped: the operator id is not a valid namespace', { operatorId, key });
      return;
    }
    if (!this.session.connected) return;
    try {
      const args = { key, value: text, namespace, tags, upsert: true, provenance_type: 'agent_output' };
      const answer = await this.call('memory_store', args, Date.now() + this.timeoutMs);
      assertStored(answer.json);
    } catch (error) {
      this.log.warn('Ruflo remember failed; the note was not stored', { operatorId, key, error: errorMessage(error) });
    }
  }

  async route(task: string): Promise<RouteAdvice> {
    if (!this.session.connected) return { tier: 3, reason: DISCONNECTED_REASON };
    try {
      const answer = await this.call('hooks_route', { task }, Date.now() + this.timeoutMs);
      return parseRouteAdvice(answer.json, answer.text);
    } catch (error) {
      const message = errorMessage(error);
      this.log.warn('Ruflo routing failed; using the large model', { error: message });
      return { tier: 3, reason: `Ruflo could not route this task (${message.slice(0, MAX_REASON_ERROR)}), so the large model is used.` };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.session.close();
    } catch (error) {
      this.log.warn('closing the Ruflo connection failed', { error: errorMessage(error) });
    }
    try {
      this.options.onClosed?.();
    } catch (error) {
      this.log.warn('cleaning up after Ruflo failed', { error: errorMessage(error) });
    }
  }

  /** memory_search returns a shortened preview of long values; fetch the full text while time remains. */
  private async withFullText(hits: SearchHit[], namespace: string, deadline: number): Promise<MemoryHit[]> {
    return Promise.all(
      hits.map(async (hit): Promise<MemoryHit> => {
        const found = { key: hit.key, text: hit.text, score: hit.score };
        if (!hit.preview) return found;
        try {
          const answer = await this.call('memory_retrieve', { key: hit.key, namespace }, deadline);
          return { ...found, text: parseRetrievedText(answer.json) ?? hit.text };
        } catch {
          return found;
        }
      }),
    );
  }

  /** One tool call that settles by `deadline`, aborting the request when it does not. */
  private async call(name: string, args: Record<string, unknown>, deadline: number): Promise<ToolAnswer> {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new Error(`${name} was not sent: no time was left`);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${name} timed out after ${budget} ms`));
      }, budget);
    });
    try {
      const result = await Promise.race([this.session.callTool(name, args, controller.signal), expired]);
      return { json: toolJson(result), text: toolText(result) };
    } finally {
      clearTimeout(timer);
    }
  }
}
