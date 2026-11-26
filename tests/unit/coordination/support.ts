import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolSession } from '../../../src/server/coordination/session.js';
import type { RufloCommand } from '../../../src/server/coordination/session.js';

export const STUB_SERVER = join(import.meta.dirname, 'fixtures', 'stub-ruflo.mjs');

/** An MCP tool result whose text is `value` as JSON. */
export function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Start the stub server in `mode`; it writes its pid, cwd and environment to `report`. */
export function stubCommand(mode: string, report: string): RufloCommand {
  return { command: process.execPath, args: [STUB_SERVER, '--mode', mode, '--report', report] };
}

const reportSchema = z.object({
  pid: z.number(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});

export type StubReport = z.infer<typeof reportSchema>;

export function readReport(path: string): StubReport {
  return reportSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

type Handler = (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown> | unknown;

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

/** A ToolSession that answers from `handlers` and records every call. */
export class FakeSession implements ToolSession {
  connected = true;
  readonly serverVersion = 'fake';
  readonly calls: ToolCall[] = [];
  closeCount = 0;
  closeError: Error | null = null;

  constructor(private readonly handlers: Record<string, Handler> = {}) {}

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    this.calls.push({ name, args, signal });
    const handler = this.handlers[name];
    if (handler === undefined) throw new Error(`Tool not found: ${name}`);
    return handler(args, signal);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.connected = false;
    if (this.closeError) throw this.closeError;
  }

  names(): string[] {
    return this.calls.map((call) => call.name);
  }
}

/** A promise that never settles, for a server that stopped answering. */
export function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}
