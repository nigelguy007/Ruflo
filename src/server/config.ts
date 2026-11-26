import { resolve } from 'node:path';
import { z } from 'zod';
import type { Mode } from '../shared/types.js';

/**
 * All runtime configuration comes from the environment and is validated once,
 * at boot. Nothing else in the server reads process.env.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MIN_TOKEN_LENGTH = 24;

const envSchema = z.object({
  SWITCHYARD_PORT: z.coerce.number().int().min(0).max(65535).default(4310),
  SWITCHYARD_HOST: z.string().min(1).default('127.0.0.1'),
  /** Bearer token for the API. Required when the host is not loopback. */
  SWITCHYARD_TOKEN: z.string().min(MIN_TOKEN_LENGTH).optional(),
  SWITCHYARD_DB: z.string().min(1).default('./data/switchyard.db'),
  SWITCHYARD_CONFIG_DIR: z.string().min(1).default('./config'),
  SWITCHYARD_WEB_DIR: z.string().min(1).default('./dist/web'),
  /** simulate: scripted agents, commands are dry runs. live: real sessions and commands. */
  SWITCHYARD_MODE: z.enum(['simulate', 'live']).default('simulate'),
  /** Repository checkout that live sessions and commands run in. */
  SWITCHYARD_WORKDIR: z.string().min(1).optional(),
  /** auto: use Ruflo when it starts, otherwise fall back to local memory. */
  SWITCHYARD_COORDINATION: z.enum(['auto', 'ruflo', 'local']).default('auto'),
  /** Pause between simulated steps so a person can watch a run unfold. */
  SWITCHYARD_STEP_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(900),
  SWITCHYARD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** Binaries a command step may execute in live mode, comma separated. */
  SWITCHYARD_ALLOWED_COMMANDS: z.string().default('git,npm,pnpm,node,gh'),
  SWITCHYARD_CLAUDE_BIN: z.string().min(1).default('claude'),
  SWITCHYARD_CODEX_BIN: z.string().min(1).default('codex'),
  SENTRY_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export interface Config {
  port: number;
  host: string;
  token: string | null;
  isLoopback: boolean;
  dbPath: string;
  configDir: string;
  webDir: string;
  mode: Mode;
  workdir: string | null;
  coordination: 'auto' | 'ruflo' | 'local';
  stepDelayMs: number;
  concurrency: number;
  allowedCommands: string[];
  claudeBin: string;
  codexBin: string;
  sentrySecret: string | null;
  githubSecret: string | null;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  const isLoopback = LOOPBACK_HOSTS.has(e.SWITCHYARD_HOST);

  if (!isLoopback && !e.SWITCHYARD_TOKEN) {
    throw new ConfigError(
      `SWITCHYARD_TOKEN (at least ${MIN_TOKEN_LENGTH} characters) is required when SWITCHYARD_HOST is not loopback.`,
    );
  }
  if (e.SWITCHYARD_MODE === 'live' && !e.SWITCHYARD_WORKDIR) {
    throw new ConfigError('SWITCHYARD_WORKDIR is required in live mode.');
  }

  return {
    port: e.SWITCHYARD_PORT,
    host: e.SWITCHYARD_HOST,
    token: e.SWITCHYARD_TOKEN ?? null,
    isLoopback,
    dbPath: e.SWITCHYARD_DB === ':memory:' ? ':memory:' : resolve(e.SWITCHYARD_DB),
    configDir: resolve(e.SWITCHYARD_CONFIG_DIR),
    webDir: resolve(e.SWITCHYARD_WEB_DIR),
    mode: e.SWITCHYARD_MODE,
    workdir: e.SWITCHYARD_WORKDIR ? resolve(e.SWITCHYARD_WORKDIR) : null,
    coordination: e.SWITCHYARD_COORDINATION,
    stepDelayMs: e.SWITCHYARD_STEP_DELAY_MS,
    concurrency: e.SWITCHYARD_CONCURRENCY,
    allowedCommands: e.SWITCHYARD_ALLOWED_COMMANDS.split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0),
    claudeBin: e.SWITCHYARD_CLAUDE_BIN,
    codexBin: e.SWITCHYARD_CODEX_BIN,
    sentrySecret: e.SENTRY_CLIENT_SECRET ?? null,
    githubSecret: e.GITHUB_WEBHOOK_SECRET ?? null,
  };
}
