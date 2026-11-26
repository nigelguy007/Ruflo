/**
 * Ports: the seams between the engine and everything that touches the outside
 * world. The engine depends only on these interfaces; adapters live under
 * executors/, coordination/ and signals/.
 */
import type {
  AgentStep,
  Artifact,
  CoordinationKind,
  Harness,
  Id,
  Operator,
  Run,
  Severity,
  Signal,
  SignalSource,
} from '../shared/types.js';

// ── Executors: run one agent step ────────────────────────────────────────────

export interface MemoryHit {
  key: string;
  text: string;
  /** 0..1, higher is closer. */
  score: number;
}

export interface StepContext {
  run: Run;
  step: AgentStep;
  operator: Operator;
  signal: Signal;
  /** What this operator remembered that looks relevant to the signal. */
  recalled: MemoryHit[];
  /** Summaries of the steps that already finished in this run, in order. */
  prior: { stepId: string; title: string; summary: string }[];
  /** Repository checkout the session should work in; null in simulate mode. */
  workdir: string | null;
}

/** Something an agent says is true. The engine records it as `claimed`, never `verified`. */
export interface Claim {
  label: string;
  detail: string;
  ok: boolean | null;
}

export interface StepResult {
  ok: boolean;
  /** Two or three sentences, written for a human skimming the timeline. */
  summary: string;
  artifacts: Artifact[];
  claims: Claim[];
  costUsd?: number;
}

export interface Executor {
  readonly harness: Harness;
  /** Must reject with an AbortError-shaped error when `abort` fires. */
  run(ctx: StepContext, abort: AbortSignal): Promise<StepResult>;
}

// ── Command runner: run one command step ─────────────────────────────────────

export interface CommandResult {
  exitCode: number;
  /** Combined stdout and stderr, truncated to a sane size. */
  output: string;
  /** true when nothing was executed (simulate mode). */
  dryRun: boolean;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd: string | null;
  timeoutMs: number;
  abort: AbortSignal;
}

export interface CommandRunner {
  run(argv: string[], opts: CommandOptions): Promise<CommandResult>;
}

// ── Coordination: memory and routing, backed by Ruflo when available ─────────

export interface RouteAdvice {
  /** 1 = deterministic, 2 = small model, 3 = large model. */
  tier: 1 | 2 | 3;
  reason: string;
}

export interface Coordination {
  readonly kind: CoordinationKind;
  recall(operatorId: Id, query: string, limit: number): Promise<MemoryHit[]>;
  remember(operatorId: Id, key: string, text: string, tags: string[]): Promise<void>;
  route(task: string): Promise<RouteAdvice>;
  close(): Promise<void>;
}

// ── Signal adapters: verify and normalise inbound webhooks ───────────────────

export interface NormalisedSignal {
  source: SignalSource;
  kind: string;
  title: string;
  fingerprint: string;
  url: string | null;
  severity: Severity;
  payload: Record<string, unknown>;
}

export interface SignalAdapter {
  readonly source: Extract<SignalSource, 'sentry' | 'github'>;
  /**
   * Constant-time check of the provider's HMAC signature over the exact raw body.
   * Header names are lower-cased by the caller.
   */
  verify(rawBody: string, headers: Record<string, string>, secret: string): boolean;
  /** Returns null for deliveries that are valid but not interesting (pings, etc). */
  normalise(body: unknown, headers: Record<string, string>): NormalisedSignal | null;
}

// ── Logging ──────────────────────────────────────────────────────────────────

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
