import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Decision, DecisionStatus, Id, IsoTime } from '../../shared/types.js';
import { createStatementCache } from './database.js';
import type { Prepare } from './database.js';
import { evidenceSchema } from './evidence.js';
import { integer, json, oneOf, text, textOrNull } from './rows.js';
import type { Row } from './rows.js';
import { storableText, storableTextOrNull } from './text.js';

export const DECISION_STATUSES: readonly DecisionStatus[] = ['open', 'approved', 'rejected'];
const evidenceListSchema = z.array(evidenceSchema);

export interface DecisionFilter {
  status?: DecisionStatus;
  limit: number;
}

export interface Resolution {
  status: Exclude<DecisionStatus, 'open'>;
  decidedAt: IsoTime;
  decidedBy: string;
  note: string | null;
}

function toDecision(row: Row): Decision {
  return {
    id: text(row, 'id'),
    runId: text(row, 'run_id'),
    runTitle: text(row, 'run_title'),
    stepId: text(row, 'step_id'),
    question: text(row, 'question'),
    status: oneOf(row, 'status', DECISION_STATUSES),
    openedAt: text(row, 'opened_at'),
    decidedAt: textOrNull(row, 'decided_at'),
    decidedBy: textOrNull(row, 'decided_by'),
    note: textOrNull(row, 'note'),
    evidence: json(row, 'evidence', evidenceListSchema),
  };
}

export class DecisionRepository {
  private readonly prepare: Prepare;

  constructor(db: DatabaseSync) {
    this.prepare = createStatementCache(db);
  }

  /** Returns the decision as stored: free text with anything SQLite cannot keep replaced by U+FFFD. */
  insert(input: Decision): Decision {
    const decision: Decision = {
      ...input,
      runTitle: storableText(input.runTitle),
      question: storableText(input.question),
      decidedBy: storableTextOrNull(input.decidedBy),
      note: storableTextOrNull(input.note),
    };
    this.prepare(
      `INSERT INTO decisions (id, run_id, run_title, step_id, question, status, opened_at,
                              decided_at, decided_by, note, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.id,
      decision.runId,
      decision.runTitle,
      decision.stepId,
      decision.question,
      decision.status,
      decision.openedAt,
      decision.decidedAt,
      decision.decidedBy,
      decision.note,
      JSON.stringify(decision.evidence),
    );
    return decision;
  }

  get(id: Id): Decision | null {
    const row = this.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? toDecision(row) : null;
  }

  /** Newest first. */
  list(filter: DecisionFilter): Decision[] {
    const rows =
      filter.status === undefined
        ? this.prepare('SELECT * FROM decisions ORDER BY seq DESC LIMIT ?').all(filter.limit)
        : this.prepare('SELECT * FROM decisions WHERE status = ? ORDER BY seq DESC LIMIT ?').all(
            filter.status,
            filter.limit,
          );
    return rows.map(toDecision);
  }

  count(status?: DecisionStatus): number {
    const row =
      status === undefined
        ? this.prepare('SELECT COUNT(*) AS n FROM decisions').get()
        : this.prepare('SELECT COUNT(*) AS n FROM decisions WHERE status = ?').get(status);
    return row ? integer(row, 'n') : 0;
  }

  openForRun(runId: Id): Decision | null {
    const row = this.prepare(
      `SELECT * FROM decisions WHERE run_id = ? AND status = 'open' ORDER BY seq DESC LIMIT 1`,
    ).get(runId);
    return row ? toDecision(row) : null;
  }

  latestForRun(runId: Id): Decision | null {
    const row = this.prepare(
      'SELECT * FROM decisions WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
    ).get(runId);
    return row ? toDecision(row) : null;
  }

  /**
   * Closes a decision only if it is still open. Returns null when it was
   * already decided, so two answers can never both win.
   */
  resolve(id: Id, resolution: Resolution): Decision | null {
    const result = this.prepare(
      `UPDATE decisions SET status = ?, decided_at = ?, decided_by = ?, note = ?
       WHERE id = ? AND status = 'open'`,
    ).run(
      resolution.status,
      resolution.decidedAt,
      storableText(resolution.decidedBy),
      storableTextOrNull(resolution.note),
      id,
    );
    return Number(result.changes) === 1 ? this.get(id) : null;
  }

  /** Decisions answered at or after `since` by anyone other than `exceptBy`. */
  countDecidedSince(since: IsoTime, exceptBy: string): number {
    const row = this.prepare(
      `SELECT COUNT(*) AS n FROM decisions
       WHERE status != 'open' AND decided_at >= ? AND decided_by != ?`,
    ).get(since, exceptBy);
    return row ? integer(row, 'n') : 0;
  }
}
