import { API } from '../../../shared/api';
import type {
  ApiEnvelope,
  Decision,
  DecisionInput,
  DecisionStatus,
  Health,
  LedgerCheck,
  ManualSignalInput,
  Operator,
  Overview,
  Playbook,
  Run,
  RunDetail,
  RunStatus,
  Schedule,
  Settings,
  Signal,
  SignalResult,
  Watch,
} from '../../../shared/types';
import { demandToken, getToken } from './auth';

/**
 * One typed error for everything that can go wrong talking to the server.
 * `code` is one of the contract's error codes, or `network` / `invalid_response`
 * when we never got an envelope at all.
 */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function toApiError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error;
  const message = error instanceof Error ? error.message : 'Something unexpected went wrong.';
  return new ApiRequestError('internal', message, 0);
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { success?: unknown }).success === 'boolean';
}

async function readEnvelope(response: Response): Promise<ApiEnvelope<unknown> | null> {
  try {
    const body: unknown = await response.json();
    return isEnvelope(body) ? body : null;
  } catch {
    return null;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError('network', 'Could not reach the Switchyard server.', 0);
  }

  const envelope = await readEnvelope(response);
  if (response.status === 401 || envelope?.error?.code === 'unauthorized') demandToken();

  if (!envelope) {
    throw new ApiRequestError(
      response.status === 401 ? 'unauthorized' : 'invalid_response',
      `The server answered ${response.status} without a readable body.`,
      response.status,
    );
  }
  if (!envelope.success || envelope.data === null) {
    throw new ApiRequestError(
      envelope.error?.code ?? 'internal',
      envelope.error?.message ?? `The request failed (${response.status}).`,
      response.status,
    );
  }
  return envelope.data as T;
}

function withQuery(path: string, query: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export interface RunsQuery {
  status?: RunStatus | null;
  limit?: number;
}

/** Every route in src/shared/api.ts that the console calls. */
export const api = {
  health: (signal?: AbortSignal) => request<Health>(API.health, { signal }),
  overview: (signal?: AbortSignal) => request<Overview>(API.overview, { signal }),
  operators: (signal?: AbortSignal) => request<Operator[]>(API.operators, { signal }),
  playbooks: (signal?: AbortSignal) => request<Playbook[]>(API.playbooks, { signal }),
  watches: (signal?: AbortSignal) => request<Watch[]>(API.watches, { signal }),
  setWatchEnabled: (id: string, enabled: boolean) =>
    request<Watch>(API.watch(id), { method: 'PATCH', body: { enabled } }),
  schedules: (signal?: AbortSignal) => request<Schedule[]>(API.schedules, { signal }),
  signals: (limit: number, signal?: AbortSignal) =>
    request<Signal[]>(withQuery(API.signals, { limit }), { signal }),
  sendManualSignal: (input: ManualSignalInput) =>
    request<SignalResult>(API.manualSignal, { method: 'POST', body: input }),
  runs: (query: RunsQuery, signal?: AbortSignal) =>
    request<Run[]>(withQuery(API.runs, { status: query.status, limit: query.limit }), { signal }),
  run: (id: string, signal?: AbortSignal) => request<RunDetail>(API.run(id), { signal }),
  cancelRun: (id: string) => request<Run>(API.cancelRun(id), { method: 'POST' }),
  decisions: (status: DecisionStatus, signal?: AbortSignal) =>
    request<Decision[]>(withQuery(API.decisions, { status }), { signal }),
  decide: (id: string, input: DecisionInput) =>
    request<Decision>(API.decision(id), { method: 'POST', body: input }),
  settings: (signal?: AbortSignal) => request<Settings>(API.settings, { signal }),
  setPaused: (paused: boolean) => request<Settings>(API.settings, { method: 'PUT', body: { paused } }),
  verifyLedger: () => request<LedgerCheck>(API.ledgerVerify),
} as const;

/** A sentence a person can act on, for the codes the contract defines. */
export function describeError(error: ApiRequestError): string {
  switch (error.code) {
    case 'network':
      return 'The server is not answering. Check that Switchyard is running, then try again.';
    case 'unauthorized':
      return 'This server needs an access token before it will answer.';
    case 'forbidden':
      return 'That token is not allowed to do this.';
    case 'rate_limited':
      return 'Too many requests. Wait a moment, then try again.';
    case 'conflict':
      return `${error.message} It may already have been handled somewhere else.`;
    default:
      return error.message;
  }
}
