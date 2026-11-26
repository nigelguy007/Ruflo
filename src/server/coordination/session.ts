import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { errorMessage } from '../logger.js';
import type { Logger } from '../ports.js';
import { pathAndHome } from '../executors/environment.js';
import type { Environment } from '../executors/environment.js';
import { TailBuffer } from '../executors/tail-buffer.js';

/**
 * Starts the Ruflo MCP server as a child process and talks to it over stdio.
 * The child gets a minimal environment and a working directory Switchyard
 * owns. It still runs as the same operating-system user, so this limits
 * accidents, not a hostile package: the version is pinned below, and
 * SWITCHYARD_COORDINATION=local keeps npm code from running at start-up.
 */

export interface RufloCommand {
  command: string;
  args: readonly string[];
}

/** The version Switchyard was tested against; `ruflo@latest` would run whatever the registry serves today. */
export const RUFLO_VERSION = '3.80.8';

/**
 * `--prefer-offline` lets npx use its cached copy without asking the registry
 * first. Without it, and without the proxy variables the minimal environment
 * leaves out, npx waited about 70 s for the registry before starting Ruflo.
 */
export const DEFAULT_RUFLO_COMMAND: RufloCommand = {
  command: 'npx',
  args: ['-y', '--prefer-offline', `ruflo@${RUFLO_VERSION}`, 'mcp', 'start'],
};

/** Tools Switchyard calls; a server without them is treated as not started. */
export const REQUIRED_TOOLS: readonly string[] = ['memory_store', 'memory_search', 'memory_retrieve', 'hooks_route'];

const CLIENT_INFO = { name: 'switchyard', version: '0.1.0' };
const STDERR_TAIL_BYTES = 2_048;
const MAX_STDERR_IN_ERROR = 300;
const KEPT_FROM_SOURCE: ReadonlySet<string> = new Set(['PATH', 'HOME']);

export interface ToolSession {
  /** false once the server exited or the session was closed. */
  readonly connected: boolean;
  readonly serverVersion: string | null;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  command: RufloCommand;
  cwd: string;
  env: Environment;
  timeoutMs: number;
  log: Logger;
}

/**
 * PATH and HOME from `source`, Ruflo's own switches, and nothing else. The SDK
 * transport copies a few more variables (USER, SHELL, ...) from process.env
 * unless they are set, so on POSIX they are set to empty strings. On Windows
 * its list (SYSTEMROOT, APPDATA, ...) is what node needs to start at all.
 */
export function rufloEnvironment(
  source: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Environment {
  const blanked = platform === 'win32' ? [] : DEFAULT_INHERITED_ENV_VARS.filter((name) => !KEPT_FROM_SOURCE.has(name));
  return {
    ...Object.fromEntries(blanked.map((name) => [name, ''])),
    ...pathAndHome(source),
    npm_config_update_notifier: 'false',
    CLAUDE_FLOW_MODE: 'v3',
  };
}

export interface DataDir {
  path: string;
  /** Created for an in-memory database and removed again on close. */
  temporary: boolean;
}

/** `ruflo/` next to the database file, or a fresh temporary directory for `:memory:`. */
export function rufloDataDir(dbPath: string): DataDir {
  if (dbPath === ':memory:') {
    return { path: mkdtempSync(join(tmpdir(), 'switchyard-ruflo-')), temporary: true };
  }
  const path = join(dirname(dbPath), 'ruflo');
  mkdirSync(path, { recursive: true });
  return { path, temporary: false };
}

export function removeDataDir(dir: DataDir): void {
  if (dir.temporary) rmSync(dir.path, { recursive: true, force: true });
}

class McpToolSession implements ToolSession {
  private open = true;
  private closing = false;

  constructor(
    private readonly client: Client,
    log: Logger,
  ) {
    client.onclose = () => {
      this.open = false;
      if (!this.closing) log.warn('the Ruflo server exited; memory and routing fall back until restart');
    };
  }

  get connected(): boolean {
    return this.open;
  }

  get serverVersion(): string | null {
    return this.client.getServerVersion()?.version ?? null;
  }

  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return this.client.callTool({ name, arguments: args }, undefined, { signal });
  }

  /** Ends the child's stdin, then escalates to SIGTERM and SIGKILL (the SDK transport does this). */
  async close(): Promise<void> {
    this.closing = true;
    this.open = false;
    await this.client.close();
  }
}

function stderrHint(stderr: TailBuffer): string {
  const text = stderr.toString().replace(/\s+/g, ' ').trim();
  return text.length === 0 ? '' : `; last output: ${text.slice(-MAX_STDERR_IN_ERROR)}`;
}

async function handshake(client: Client, transport: StdioClientTransport, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  await client.connect(transport, { timeout: remaining() });
  const listed = await client.listTools(undefined, { timeout: remaining() });
  const names = new Set(listed.tools.map((tool) => tool.name));
  const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`the server does not offer ${missing.join(', ')}`);
}

/** Spawn the server, initialise, and check its tools, all within `timeoutMs`. Throws when any step fails. */
export async function connectRuflo(options: ConnectOptions): Promise<ToolSession> {
  const transport = new StdioClientTransport({
    command: options.command.command,
    args: [...options.command.args],
    env: options.env,
    cwd: options.cwd,
    stderr: 'pipe',
  });
  // Drain stderr for the child's whole life: an unread pipe would eventually block it.
  // Only the start-up tail is ever shown, before any memory has been sent.
  const stderr = new TailBuffer(STDERR_TAIL_BYTES);
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const client = new Client(CLIENT_INFO);
  try {
    await handshake(client, transport, options.timeoutMs);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`Ruflo did not start: ${errorMessage(error)}${stderrHint(stderr)}`);
  }
  return new McpToolSession(client, options.log);
}
