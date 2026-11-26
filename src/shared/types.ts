/**
 * Switchyard shared contract.
 *
 * Every shape that crosses the HTTP boundary lives here, so the server and the
 * console agree by construction. Keep this file types-only: no runtime code.
 */

export type Id = string;
/** ISO-8601 UTC timestamp, e.g. 2026-11-26T12:00:00.000Z */
export type IsoTime = string;

// ── Operators ────────────────────────────────────────────────────────────────

/** Which coding-agent runtime executes an operator's steps. */
export type Harness = 'simulated' | 'claude' | 'codex';

export type OperatorStatus = 'idle' | 'working' | 'waiting' | 'paused';

/** A named, persistent agent role. Defined in config/operators.json. */
export interface Operator {
  id: Id;
  name: string;
  /** Mention handle including the leading "@". */
  handle: string;
  /** One-line job description shown on the floor. */
  role: string;
  instructions: string;
  harness: Harness;
  /** Derived at read time from active runs; never stored. */
  status: OperatorStatus;
  currentRunId: Id | null;
  currentActivity: string | null;
}

// ── Signals and watches ──────────────────────────────────────────────────────

export type SignalSource = 'sentry' | 'github' | 'schedule' | 'manual';
export type Severity = 'info' | 'warning' | 'error' | 'critical';

/** A normalised inbound event. */
export interface Signal {
  id: Id;
  source: SignalSource;
  /** Dotted kind, e.g. "issue.created", "check_run.failed", "manual.run". */
  kind: string;
  title: string;
  /** Stable identity of the underlying problem; used for de-duplication. */
  fingerprint: string;
  url: string | null;
  severity: Severity;
  payload: Record<string, unknown>;
  receivedAt: IsoTime;
}

/** Binds matching signals to a playbook. Defined in config/watches.json. */
export interface Watch {
  id: Id;
  name: string;
  source: SignalSource;
  /** Signal kinds this watch accepts; empty means any kind from the source. */
  kinds: string[];
  /** Exact-match filters on dotted payload paths, e.g. {"repository.name": "api"}. */
  match: Record<string, string>;
  playbookId: Id;
  enabled: boolean;
  /** A signal with the same fingerprint inside this window joins the existing run. */
  dedupeMinutes: number;
}

/** Time-based signal source. Defined in config/schedules.json. */
export interface Schedule {
  id: Id;
  name: string;
  playbookId: Id;
  enabled: boolean;
  /** Exactly one of the two is set. */
  everyMinutes: number | null;
  /** "HH:MM" in UTC. */
  dailyAt: string | null;
}

// ── Playbooks ────────────────────────────────────────────────────────────────

export type StepKind = 'agent' | 'command' | 'gate';

interface StepBase {
  /** Unique within the playbook. */
  id: string;
  title: string;
}

/** Work done by an operator in a coding session. */
export interface AgentStep extends StepBase {
  kind: 'agent';
  operator: Id;
  instruction: string;
  /** Operator the result is handed to; recorded as a handoff on the timeline. */
  handoffTo?: Id;
  retries?: number;
  timeoutSeconds?: number;
}

/** A command the engine runs itself. Its exit code is evidence nobody had to trust. */
export interface CommandStep extends StepBase {
  kind: 'command';
  /** argv, never a shell string. */
  run: string[];
  expectExit?: number;
  timeoutSeconds?: number;
}

/** A human decision. The run stops here until someone answers. */
export interface GateStep extends StepBase {
  kind: 'gate';
  question: string;
  /** What happens when the answer is no. */
  onReject: 'stop' | 'continue';
}

export type Step = AgentStep | CommandStep | GateStep;

export interface Budget {
  /** Hard wall-clock cap for the whole run, excluding time spent waiting at a gate. */
  maxMinutes: number;
  maxAgentSteps: number;
  /** Cap on operator-to-operator handoffs, so agents cannot ping-pong forever. */
  maxHandoffs: number;
}

/** Defined in config/playbooks/*.json and reviewed like any other code. */
export interface Playbook {
  id: Id;
  name: string;
  description: string;
  version: number;
  budget: Budget;
  steps: Step[];
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_gate'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped';

export interface StepRun {
  stepId: string;
  kind: StepKind;
  title: string;
  operator: Id | null;
  status: StepStatus;
  attempt: number;
  startedAt: IsoTime | null;
  finishedAt: IsoTime | null;
  summary: string | null;
}

export interface Run {
  id: Id;
  playbookId: Id;
  playbookName: string;
  playbookVersion: number;
  signalId: Id;
  title: string;
  status: RunStatus;
  createdAt: IsoTime;
  startedAt: IsoTime | null;
  finishedAt: IsoTime | null;
  currentStepId: string | null;
  /** Why the run ended unsuccessfully, in plain words. */
  stopReason: string | null;
  /** Later signals with the same fingerprint that were folded into this run. */
  duplicateSignals: number;
  steps: StepRun[];
}

// ── Evidence, timeline, decisions ────────────────────────────────────────────

/**
 * verified  – produced by the engine itself (a command it ran, an exit code it saw)
 * claimed   – reported by an agent; plausible, not checked
 * simulated – produced in simulate mode; shown for the demo, proves nothing
 */
export type EvidenceKind = 'verified' | 'claimed' | 'simulated';

export interface Evidence {
  id: Id;
  runId: Id;
  stepId: string;
  kind: EvidenceKind;
  label: string;
  detail: string;
  /** true = supports going ahead, false = argues against, null = informational */
  ok: boolean | null;
}

export type ArtifactKind = 'pr' | 'diff' | 'log' | 'url';

export interface Artifact {
  kind: ArtifactKind;
  label: string;
  value: string;
}

export type TimelineKind =
  | 'signal'
  | 'note'
  | 'handoff'
  | 'artifact'
  | 'command'
  | 'gate_opened'
  | 'gate_resolved'
  | 'error'
  | 'system';

/** One entry in the append-only, hash-chained ledger. */
export interface TimelineEvent {
  /** Global, strictly increasing. */
  seq: number;
  id: Id;
  runId: Id;
  at: IsoTime;
  /** Operator id, "system" or "human". */
  actor: string;
  kind: TimelineKind;
  text: string;
  /** Operator ids mentioned in this entry. */
  mentions: Id[];
  data: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
}

export type DecisionStatus = 'open' | 'approved' | 'rejected';
export type Verdict = 'approve' | 'reject';

export interface Decision {
  id: Id;
  runId: Id;
  runTitle: string;
  stepId: string;
  question: string;
  status: DecisionStatus;
  openedAt: IsoTime;
  decidedAt: IsoTime | null;
  decidedBy: string | null;
  note: string | null;
  evidence: Evidence[];
}

// ── Settings, overview, API envelopes ────────────────────────────────────────

export type Mode = 'simulate' | 'live';
export type CoordinationKind = 'ruflo' | 'local';

export interface Settings {
  /** Global stop: no new step starts while true. */
  paused: boolean;
  mode: Mode;
}

export interface Health {
  status: 'ok';
  version: string;
  mode: Mode;
  paused: boolean;
  coordination: CoordinationKind;
}

export interface Digest {
  since: IsoTime;
  /** Runs that finished without ever asking a human anything. */
  handledWithoutYou: number;
  decisionsMade: number;
  succeeded: number;
  failed: number;
  rejected: number;
  cancelled: number;
}

export interface Overview {
  operators: Operator[];
  openDecisions: number;
  activeRuns: number;
  failedRuns: number;
  lastSignalAt: IsoTime | null;
  digest: Digest;
}

export interface RunDetail {
  run: Run;
  signal: Signal;
  timeline: TimelineEvent[];
  evidence: Evidence[];
  decision: Decision | null;
}

export interface SignalResult {
  /** null when the adapter recognised the delivery but chose to ignore it. */
  signal: Signal | null;
  runs: Run[];
  /** Runs that already covered this fingerprint and absorbed the signal. */
  joined: Id[];
}

export interface LedgerCheck {
  ok: boolean;
  checked: number;
  /** seq of the first entry whose hash does not match, or null. */
  brokenAt: number | null;
}

export interface ManualSignalInput {
  title: string;
  kind?: string;
  severity?: Severity;
  fingerprint?: string;
  url?: string;
  payload?: Record<string, unknown>;
  /** Skip watch matching and start this playbook directly. */
  playbookId?: Id;
}

export interface DecisionInput {
  verdict: Verdict;
  note?: string;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  meta?: { total?: number; limit?: number };
}

/** Server-sent events on GET /api/stream. `event:` is the type, `data:` is this JSON. */
export type StreamEvent =
  | { type: 'run.updated'; run: Run }
  | { type: 'timeline.appended'; event: TimelineEvent }
  | { type: 'decision.opened'; decision: Decision }
  | { type: 'decision.resolved'; decision: Decision }
  | { type: 'signal.received'; signal: Signal }
  | { type: 'settings.updated'; settings: Settings };
