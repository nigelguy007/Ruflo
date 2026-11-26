import { describe, expect, test } from 'vitest';
import {
  RufloResponseError,
  assertStored,
  parseRetrievedText,
  parseRouteAdvice,
  parseSearchHits,
  toolJson,
  toolText,
} from '../../../src/server/coordination/parse.js';
import { textResult } from './support.js';

const NAMESPACE = 'switchyard:fitter';

/** memory_search as ruflo 3.80.8 answered it, values shortened to 60 characters plus "...". */
const OBSERVED_SEARCH = {
  query: 'TypeError cart.total is undefined',
  results: [
    {
      key: 'probe-1',
      namespace: NAMESPACE,
      value: 'Fixed TypeError cart.total undefined in checkout by guarding...',
      similarity: 0.8597030706939379,
      provenanceType: 'agent_output',
    },
    {
      key: 'probe-2',
      namespace: NAMESPACE,
      value: 'Nightly dependency check',
      similarity: 0.12325801046280697,
      provenanceType: 'agent_output',
    },
  ],
  total: 2,
  searchTime: '5.58ms',
  backend: 'HNSW + sql.js',
};

/** hooks_route as ruflo 3.80.8 answered it: an agent suggestion and no tier. */
const OBSERVED_ROUTE = {
  task: 'Fix TypeError: cart.total is undefined in checkout',
  routing: { method: 'semantic-native', backend: 'native VectorDb (HNSW)', latencyMs: 0.16, throughput: '6294 routes/s' },
  matchedPattern: 'testing-task',
  matched: true,
  semanticMatches: [{ pattern: 'testing-task', score: 0.42 }],
  primaryAgent: { type: 'tester', confidence: 0.42, reason: 'Semantic similarity to "testing-task" pattern (42%)' },
  alternativeAgents: [{ type: 'reviewer', confidence: 0.32, reason: 'Alternative agent' }],
  estimatedMetrics: { successProbability: 0.42, estimatedDuration: '10-30 min', complexity: 'low' },
  swarmRecommendation: null,
  embedder: 'hash',
};

describe('toolJson', () => {
  test('returns the JSON document inside the first text item', () => {
    expect(toolJson(textResult({ success: true, stored: true }))).toEqual({ success: true, stored: true });
  });

  test('rejects a result the tool marked as an error, with its text', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'namespace contains invalid characters' }] };
    expect(() => toolJson(result)).toThrow(/tool reported an error: namespace contains invalid characters/);
  });

  test('rejects text that is not JSON', () => {
    expect(() => toolJson({ content: [{ type: 'text', text: 'Stored!' }] })).toThrow('tool result is not JSON');
  });

  test('rejects a result without text content', () => {
    expect(() => toolJson({ content: [{ type: 'image', data: 'x' }] })).toThrow('no text content');
  });

  test('rejects anything that is not a tool result', () => {
    expect(() => toolJson(null)).toThrow(RufloResponseError);
    expect(() => toolJson({ content: 'nope' })).toThrow('unexpected tool result shape');
  });

  test('turns a handler refusal ({ success: false }) into an error', () => {
    expect(() => toolJson(textResult({ success: false, error: 'task is too long' }))).toThrow(
      'tool refused the call: task is too long',
    );
    expect(() => toolJson(textResult({ success: false }))).toThrow('no detail');
  });
});

describe('toolText', () => {
  test('joins every text item', () => {
    const result = { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] };
    expect(toolText(result)).toBe('a\nb');
  });

  test('is empty for something that is not a tool result', () => {
    expect(toolText(42)).toBe('');
  });
});

describe('assertStored', () => {
  test('accepts the observed memory_store answer', () => {
    expect(() =>
      assertStored({ success: true, key: 'run:1', namespace: NAMESPACE, stored: true, hasEmbedding: true }),
    ).not.toThrow();
  });

  test('rejects an answer that does not confirm success', () => {
    expect(() => assertStored({ key: 'run:1' })).toThrow('did not confirm success');
    expect(() => assertStored({ success: true, stored: false })).toThrow('was not stored');
  });
});

describe('parseSearchHits', () => {
  test('reads the observed answer, closest first, and flags shortened previews', () => {
    expect(parseSearchHits(OBSERVED_SEARCH, NAMESPACE, 5)).toEqual([
      {
        key: 'probe-1',
        text: 'Fixed TypeError cart.total undefined in checkout by guarding...',
        score: 0.8597030706939379,
        preview: true,
      },
      { key: 'probe-2', text: 'Nightly dependency check', score: 0.12325801046280697, preview: false },
    ]);
  });

  test('drops hits from another namespace and hits it cannot read', () => {
    const value = {
      results: [
        { key: 'mine', namespace: NAMESPACE, value: 'ok', similarity: 0.5 },
        { key: 'theirs', namespace: 'switchyard:scout', value: 'not yours', similarity: 0.9 },
        { key: 'no-score', namespace: NAMESPACE, value: 'x' },
        { key: '', value: 'empty key', similarity: 0.9 },
        { key: 'empty', value: '   ', similarity: 0.9 },
        { key: 'null', value: null, similarity: 0.9 },
        'not an object',
      ],
    };
    expect(parseSearchHits(value, NAMESPACE, 10).map((hit) => hit.key)).toEqual(['mine']);
  });

  test('sorts, clamps scores to 0..1, stringifies object values and honours the limit', () => {
    const value = {
      results: [
        { key: 'low', value: 'low', similarity: -0.2 },
        { key: 'object', value: { note: 'structured' }, similarity: 0.4 },
        { key: 'high', value: 'high', similarity: 1.7 },
      ],
    };
    const hits = parseSearchHits(value, NAMESPACE, 2);
    expect(hits.map((hit) => [hit.key, hit.score])).toEqual([
      ['high', 1],
      ['object', 0.4],
    ]);
    expect(hits[1]?.text).toBe('{"note":"structured"}');
    expect(parseSearchHits(value, NAMESPACE, 0)).toEqual([]);
  });

  test('rejects an answer without a results list', () => {
    expect(() => parseSearchHits({ total: 0 }, NAMESPACE, 3)).toThrow('no results list');
  });
});

describe('parseRetrievedText', () => {
  test('returns the full stored value', () => {
    expect(parseRetrievedText({ key: 'k', value: 'the whole note', found: true })).toBe('the whole note');
  });

  test('returns null when the entry is missing or unreadable', () => {
    expect(parseRetrievedText({ key: 'k', value: null, found: false })).toBeNull();
    expect(parseRetrievedText({ key: 'k', value: 'stale', found: false })).toBeNull();
    expect(parseRetrievedText('nope')).toBeNull();
  });
});

describe('parseRouteAdvice', () => {
  test('the observed hooks_route answer has no tier, so the advice stays at tier 3', () => {
    const advice = parseRouteAdvice(OBSERVED_ROUTE, JSON.stringify(OBSERVED_ROUTE));
    expect(advice.tier).toBe(3);
    expect(advice.reason).toBe(
      'Ruflo suggests a tester agent, 42% confidence, low complexity; it named no model tier, so the large model is used.',
    );
  });

  test('uses a tier Ruflo states, at the top level or under modelRouting', () => {
    expect(parseRouteAdvice({ ...OBSERVED_ROUTE, tier: 2 }, '').tier).toBe(2);
    const preTaskShape = { modelRouting: { tier: 1, handler: 'codemod', codemodIntent: 'var-to-const' } };
    const advice = parseRouteAdvice(preTaskShape, '');
    expect(advice).toEqual({ tier: 1, reason: 'Ruflo gave no agent suggestion; Ruflo recommends tier 1.' });
  });

  test('treats the codemod marker as tier 1', () => {
    const raw = `${JSON.stringify(OBSERVED_ROUTE)}\n[CODEMOD_AVAILABLE] Skip LLM`;
    expect(parseRouteAdvice(OBSERVED_ROUTE, raw).tier).toBe(1);
  });

  test('ignores tier values outside 1..3 and malformed optional fields', () => {
    const odd = { tier: 7, modelRouting: 'fast', primaryAgent: { type: 'coder', confidence: 'high' }, estimatedMetrics: 3 };
    expect(parseRouteAdvice(odd, '')).toEqual({
      tier: 3,
      reason: 'Ruflo suggests a coder agent; it named no model tier, so the large model is used.',
    });
  });

  test('rejects an answer that is not an object', () => {
    expect(() => parseRouteAdvice('route me', '')).toThrow('not an object');
  });
});
