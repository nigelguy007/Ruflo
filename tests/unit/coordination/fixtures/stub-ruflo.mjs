/**
 * A stand-in for `ruflo mcp start`, spawned by the coordination tests with
 * `node stub-ruflo.mjs --mode <mode> [--report <file>]`. Its answers copy the
 * shapes ruflo 3.80.8 returned for the same tools.
 *
 * Modes: normal, missing-tools, slow-search, garbage, exit-on-search, no-handshake.
 */
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PREVIEW_LENGTH = 60;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const mode = option('mode', 'normal');
const report = option('report', null);
if (report) {
  writeFileSync(report, JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env }));
}

if (mode === 'no-handshake') {
  // Started, but never answers the initialize request.
  setInterval(() => undefined, 1_000);
} else {
  await serve();
}

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function words(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function similarity(query, value) {
  const wanted = words(query);
  if (wanted.size === 0) return 0;
  const have = words(value);
  return [...wanted].filter((word) => have.has(word)).length / wanted.size;
}

function checkNamespace(namespace) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(namespace)) {
    throw new Error('namespace contains invalid characters (allowed: alphanumeric, _, -, ., :)');
  }
}

async function serve() {
  const server = new McpServer({ name: 'ruflo', version: '3.80.8-stub' });
  const memory = new Map();
  const answer = (value) => (mode === 'garbage' ? text('this is not json') : text(value));

  server.registerTool(
    'memory_store',
    {
      inputSchema: {
        key: z.string(),
        value: z.unknown(),
        namespace: z.string().optional(),
        tags: z.array(z.string()).optional(),
        upsert: z.boolean().optional(),
        provenance_type: z.string().optional(),
      },
    },
    async ({ key, value, namespace = 'default', tags = [], provenance_type = 'unknown' }) => {
      checkNamespace(namespace);
      memory.set(`${namespace}\u0000${key}`, { key, namespace, value, tags, provenance_type });
      return answer({ success: true, key, namespace, stored: true, hasEmbedding: true, provenanceType: provenance_type });
    },
  );
  if (mode === 'missing-tools') {
    await server.connect(new StdioServerTransport());
    return;
  }

  server.registerTool(
    'memory_search',
    {
      inputSchema: {
        query: z.string(),
        namespace: z.string().optional(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      },
    },
    async ({ query, namespace, limit = 10, threshold = 0.2 }) => {
      if (mode === 'exit-on-search') process.exit(3);
      if (mode === 'slow-search') await new Promise((resolve) => setTimeout(resolve, 10_000));
      const results = [...memory.values()]
        .filter((entry) => namespace === undefined || entry.namespace === namespace)
        .map((entry) => ({ entry, score: similarity(query, entry.value) }))
        .filter(({ score }) => score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ entry, score }) => {
          const full = String(entry.value);
          const value = full.length > PREVIEW_LENGTH ? `${full.slice(0, PREVIEW_LENGTH)}...` : full;
          return { key: entry.key, namespace: entry.namespace, value, similarity: score, provenanceType: entry.provenance_type };
        });
      return answer({ query, results, total: results.length, backend: 'stub' });
    },
  );

  server.registerTool(
    'memory_retrieve',
    { inputSchema: { key: z.string(), namespace: z.string().optional() } },
    async ({ key, namespace = 'default' }) => {
      const entry = memory.get(`${namespace}\u0000${key}`);
      return answer(
        entry === undefined
          ? { key, namespace, value: null, found: false }
          : { key, namespace, value: entry.value, tags: entry.tags, found: true },
      );
    },
  );

  server.registerTool('hooks_route', { inputSchema: { task: z.string() } }, async ({ task }) =>
    answer({
      task,
      routing: { method: 'keyword', backend: 'stub' },
      matchedPattern: 'testing-task',
      matched: true,
      primaryAgent: { type: 'tester', confidence: 0.42, reason: 'Semantic similarity to "testing-task"' },
      estimatedMetrics: { successProbability: 0.42, estimatedDuration: '10-30 min', complexity: 'low' },
    }),
  );

  await server.connect(new StdioServerTransport());
}
