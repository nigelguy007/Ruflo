import type { Context } from 'hono';
import type { z } from 'zod';
import { listQuerySchema } from '../../shared/schemas.js';
import type { DecisionStatus, RunStatus } from '../../shared/types.js';
import { DECISION_STATUSES, RUN_STATUSES } from '../db/index.js';
import { HttpError } from './envelope.js';

const MAX_ISSUE_TEXT = 500;
const PATH_ID = /^[A-Za-z0-9_-]{1,120}$/;

export interface ListQuery {
  limit: number;
  status: string | undefined;
}

function describeIssues(error: z.ZodError): string {
  const text = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`)
    .join('; ');
  return text.slice(0, MAX_ISSUE_TEXT);
}

/** Reads the body as JSON and validates it. Anything malformed is a 400 that says what was wrong. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw = await c.req.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError('bad_request', 'The request body must be valid JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError('bad_request', describeIssues(result.error));
  return result.data;
}

export function readListQuery(c: Context): ListQuery {
  const result = listQuerySchema.safeParse(c.req.query());
  if (!result.success) throw new HttpError('bad_request', describeIssues(result.error));
  return { limit: result.data.limit, status: result.data.status };
}

/** `?status=running` or `?status=queued,running`; empty means every status. */
export function runStatuses(status: string | undefined): RunStatus[] {
  if (status === undefined || status.trim() === '') return [];
  return status.split(',').map((part) => {
    const match = RUN_STATUSES.find((known) => known === part.trim());
    if (match === undefined) {
      throw new HttpError('bad_request', `status must be one of ${RUN_STATUSES.join(', ')}.`);
    }
    return match;
  });
}

export function decisionStatus(status: string | undefined): DecisionStatus | undefined {
  if (status === undefined || status.trim() === '') return undefined;
  const match = DECISION_STATUSES.find((known) => known === status.trim());
  if (match === undefined) {
    throw new HttpError('bad_request', `status must be one of ${DECISION_STATUSES.join(', ')}.`);
  }
  return match;
}

/** Ids in the path are looked up, never trusted; anything that cannot be an id is simply not found. */
export function pathId(c: Context, what: string): string {
  const id = c.req.param('id') ?? '';
  if (!PATH_ID.test(id)) throw new HttpError('not_found', `${what} ${JSON.stringify(id.slice(0, 40))} does not exist.`);
  return id;
}
