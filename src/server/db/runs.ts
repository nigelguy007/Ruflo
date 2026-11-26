import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { playbookSchema } from '../../shared/schemas.js';
import type {
  Id,
  IsoTime,
  Playbook,
  Run,
  RunStatus,
  Step,
  StepKind,
  StepRun,
  StepStatus,
} from '../../shared/types.js';
import { createStatementCache } from './database.js';
import type { Prepare } from './database.js';
import { integer, json, oneOf, placeholders, text, textOrNull } from './rows.js';
import type { Row } from './rows.js';

export const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting_gate',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
];
export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_gate'];
const STEP_STATUSES: readonly StepStatus[] = [
  'pending',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
];
const STEP_KINDS: readonly StepKind[] = ['agent', 'command', 'gate'];

export interface NewRun {
  id: Id;
  playbook: Playbook;
  signalId: Id;
  fingerprint: string;
  title: string;
  createdAt: IsoTime;
}

/** Bookkeeping the engine needs and the API never shows. */
export interface RunMeta {
  fingerprint: string;
  /** Held back by the global pause. */
  parked: boolean;
  /** Total time spent waiting at gates; excluded from the budget. */
  gateWaitMs: number;
  agentStepsStarted: number;
  handoffs: number;
}

export interface RunPatch {
  status?: RunStatus;
  startedAt?: IsoTime | null;
  finishedAt?: IsoTime | null;
  currentStepId?: string | null;
  stopReason?: string | null;
  parked?: boolean;
  addDuplicateSignals?: number;
  addGateWaitMs?: number;
  addAgentStepsStarted?: number;
  addHandoffs?: number;
}

export interface StepPatch {
  status?: StepStatus;
  attempt?: number;
  startedAt?: IsoTime | null;
  finishedAt?: IsoTime | null;
  summary?: string | null;
}

export interface RunFilter {
  statuses?: readonly RunStatus[];
  limit: number;
}

export interface DigestCounts {
  succeeded: number;
  failed: number;
  rejected: number;
  cancelled: number;
  /** Succeeded without ever opening a decision. */
  handledWithoutYou: number;
}

type Assignment = readonly [clause: string, value: SQLInputValue];

function toStepRun(row: Row): StepRun {
  return {
    stepId: text(row, 'step_id'),
    kind: oneOf(row, 'kind', STEP_KINDS),
    title: text(row, 'title'),
    operator: textOrNull(row, 'operator'),
    status: oneOf(row, 'status', STEP_STATUSES),
    attempt: integer(row, 'attempt'),
    startedAt: textOrNull(row, 'started_at'),
    finishedAt: textOrNull(row, 'finished_at'),
    summary: textOrNull(row, 'summary'),
  };
}

function toRun(row: Row, steps: StepRun[]): Run {
  return {
    id: text(row, 'id'),
    playbookId: text(row, 'playbook_id'),
    playbookName: text(row, 'playbook_name'),
    playbookVersion: integer(row, 'playbook_version'),
    signalId: text(row, 'signal_id'),
    title: text(row, 'title'),
    status: oneOf(row, 'status', RUN_STATUSES),
    createdAt: text(row, 'created_at'),
    startedAt: textOrNull(row, 'started_at'),
    finishedAt: textOrNull(row, 'finished_at'),
    currentStepId: textOrNull(row, 'current_step_id'),
    stopReason: textOrNull(row, 'stop_reason'),
    duplicateSignals: integer(row, 'duplicate_signals'),
    steps,
  };
}

function runAssignments(patch: RunPatch): Assignment[] {
  const out: Assignment[] = [];
  if (patch.status !== undefined) out.push(['status = ?', patch.status]);
  if (patch.startedAt !== undefined) out.push(['started_at = ?', patch.startedAt]);
  if (patch.finishedAt !== undefined) out.push(['finished_at = ?', patch.finishedAt]);
  if (patch.currentStepId !== undefined) out.push(['current_step_id = ?', patch.currentStepId]);
  if (patch.stopReason !== undefined) out.push(['stop_reason = ?', patch.stopReason]);
  if (patch.parked !== undefined) out.push(['parked = ?', patch.parked ? 1 : 0]);
  if (patch.addDuplicateSignals !== undefined) {
    out.push(['duplicate_signals = duplicate_signals + ?', patch.addDuplicateSignals]);
  }
  if (patch.addGateWaitMs !== undefined) {
    out.push(['gate_wait_ms = gate_wait_ms + ?', Math.max(0, Math.round(patch.addGateWaitMs))]);
  }
  if (patch.addAgentStepsStarted !== undefined) {
    out.push(['agent_steps_started = agent_steps_started + ?', patch.addAgentStepsStarted]);
  }
  if (patch.addHandoffs !== undefined) out.push(['handoffs = handoffs + ?', patch.addHandoffs]);
  return out;
}

function stepAssignments(patch: StepPatch): Assignment[] {
  const out: Assignment[] = [];
  if (patch.status !== undefined) out.push(['status = ?', patch.status]);
  if (patch.attempt !== undefined) out.push(['attempt = ?', patch.attempt]);
  if (patch.startedAt !== undefined) out.push(['started_at = ?', patch.startedAt]);
  if (patch.finishedAt !== undefined) out.push(['finished_at = ?', patch.finishedAt]);
  if (patch.summary !== undefined) out.push(['summary = ?', patch.summary]);
  return out;
}

function stepOperator(step: Step): string | null {
  return step.kind === 'agent' ? step.operator : null;
}

export class RunRepository {
  private readonly prepare: Prepare;

  constructor(db: DatabaseSync) {
    this.prepare = createStatementCache(db);
  }

  /** Stores the run with a snapshot of its playbook, so later config edits cannot change a run in flight. */
  insert(run: NewRun): Run {
    const { playbook } = run;
    this.prepare(
      `INSERT INTO runs (id, playbook_id, playbook_name, playbook_version, playbook, signal_id,
                         fingerprint, title, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      run.id,
      playbook.id,
      playbook.name,
      playbook.version,
      JSON.stringify(playbook),
      run.signalId,
      run.fingerprint,
      run.title,
      run.createdAt,
    );
    const insertStep = this.prepare(
      `INSERT INTO step_runs (run_id, position, step_id, kind, title, operator, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    playbook.steps.forEach((step, position) => {
      insertStep.run(run.id, position, step.id, step.kind, step.title, stepOperator(step));
    });
    return this.require(run.id);
  }

  get(id: Id): Run | null {
    const row = this.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!row) return null;
    return toRun(row, this.stepsFor([id]).get(id) ?? []);
  }

  require(id: Id): Run {
    const run = this.get(id);
    if (!run) throw new Error(`Run ${id} does not exist.`);
    return run;
  }

  playbook(id: Id): Playbook | null {
    const row = this.prepare('SELECT playbook FROM runs WHERE id = ?').get(id);
    return row ? json<Playbook>(row, 'playbook', playbookSchema) : null;
  }

  meta(id: Id): RunMeta | null {
    const row = this.prepare(
      'SELECT fingerprint, parked, gate_wait_ms, agent_steps_started, handoffs FROM runs WHERE id = ?',
    ).get(id);
    if (!row) return null;
    return {
      fingerprint: text(row, 'fingerprint'),
      parked: integer(row, 'parked') !== 0,
      gateWaitMs: integer(row, 'gate_wait_ms'),
      agentStepsStarted: integer(row, 'agent_steps_started'),
      handoffs: integer(row, 'handoffs'),
    };
  }

  /** Newest first. */
  list(filter: RunFilter): Run[] {
    const statuses = filter.statuses ?? [];
    const where = statuses.length > 0 ? `WHERE status IN (${placeholders(statuses.length)})` : '';
    const rows = this.prepare(`SELECT * FROM runs ${where} ORDER BY seq DESC LIMIT ?`).all(
      ...statuses,
      filter.limit,
    );
    return this.hydrate(rows);
  }

  count(statuses: readonly RunStatus[] = []): number {
    const where = statuses.length > 0 ? `WHERE status IN (${placeholders(statuses.length)})` : '';
    const row = this.prepare(`SELECT COUNT(*) AS n FROM runs ${where}`).get(...statuses);
    return row ? integer(row, 'n') : 0;
  }

  update(id: Id, patch: RunPatch): Run {
    const assignments = runAssignments(patch);
    if (assignments.length > 0) {
      const sql = `UPDATE runs SET ${assignments.map(([clause]) => clause).join(', ')} WHERE id = ?`;
      this.prepare(sql).run(...assignments.map(([, value]) => value), id);
    }
    return this.require(id);
  }

  updateStep(runId: Id, stepId: string, patch: StepPatch): Run {
    const assignments = stepAssignments(patch);
    if (assignments.length > 0) {
      const sets = assignments.map(([clause]) => clause).join(', ');
      this.prepare(`UPDATE step_runs SET ${sets} WHERE run_id = ? AND step_id = ?`).run(
        ...assignments.map(([, value]) => value),
        runId,
        stepId,
      );
    }
    return this.require(runId);
  }

  /** Marks every step that has not finished as skipped; used when a run ends early. */
  skipOpenSteps(runId: Id): Run {
    this.prepare(
      `UPDATE step_runs SET status = 'skipped'
       WHERE run_id = ? AND status IN ('pending', 'running', 'waiting')`,
    ).run(runId);
    return this.require(runId);
  }

  /** Puts steps that were mid-flight back to pending; used when recovering from a crash. */
  resetRunningSteps(runId: Id): Run {
    this.prepare(
      `UPDATE step_runs SET status = 'pending', started_at = NULL
       WHERE run_id = ? AND status = 'running'`,
    ).run(runId);
    return this.require(runId);
  }

  /** The newest active run for this playbook and fingerprint created at or after `since`. */
  findActiveDuplicate(playbookId: Id, fingerprint: string, since: IsoTime): Run | null {
    const row = this.prepare(
      `SELECT * FROM runs
       WHERE playbook_id = ? AND fingerprint = ? AND created_at >= ?
         AND status IN ('queued', 'running', 'waiting_gate')
       ORDER BY seq DESC LIMIT 1`,
    ).get(playbookId, fingerprint, since);
    return row ? (this.hydrate([row])[0] ?? null) : null;
  }

  listParked(): Run[] {
    return this.hydrate(
      this.prepare(
        `SELECT * FROM runs WHERE parked = 1 AND status IN ('queued', 'running') ORDER BY seq`,
      ).all(),
    );
  }

  digestCounts(since: IsoTime): DigestCounts {
    const counts: DigestCounts = {
      succeeded: 0,
      failed: 0,
      rejected: 0,
      cancelled: 0,
      handledWithoutYou: 0,
    };
    const rows = this.prepare(
      `SELECT status, COUNT(*) AS n FROM runs
       WHERE finished_at >= ? AND status IN ('succeeded', 'failed', 'rejected', 'cancelled')
       GROUP BY status`,
    ).all(since);
    for (const row of rows) {
      const status = oneOf(row, 'status', ['succeeded', 'failed', 'rejected', 'cancelled'] as const);
      counts[status] = integer(row, 'n');
    }
    const unattended = this.prepare(
      `SELECT COUNT(*) AS n FROM runs r
       WHERE r.finished_at >= ? AND r.status = 'succeeded'
         AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.run_id = r.id)`,
    ).get(since);
    counts.handledWithoutYou = unattended ? integer(unattended, 'n') : 0;
    return counts;
  }

  private hydrate(rows: Row[]): Run[] {
    const steps = this.stepsFor(rows.map((row) => text(row, 'id')));
    return rows.map((row) => toRun(row, steps.get(text(row, 'id')) ?? []));
  }

  /** One query for the steps of many runs, to avoid a query per run. */
  private stepsFor(runIds: Id[]): Map<Id, StepRun[]> {
    const byRun = new Map<Id, StepRun[]>();
    if (runIds.length === 0) return byRun;
    const rows = this.prepare(
      `SELECT * FROM step_runs WHERE run_id IN (${placeholders(runIds.length)})
       ORDER BY run_id, position`,
    ).all(...runIds);
    for (const row of rows) {
      const runId = text(row, 'run_id');
      byRun.set(runId, [...(byRun.get(runId) ?? []), toStepRun(row)]);
    }
    return byRun;
  }
}
