import type { OperatorConfig } from '../../../src/shared/schemas.js';
import type {
  AgentStep,
  CommandStep,
  GateStep,
  Harness,
  Playbook,
  Run,
  Schedule,
  Step,
  StreamEvent,
  Watch,
} from '../../../src/shared/types.js';
import type { Config } from '../../../src/server/config.js';
import { createStore } from '../../../src/server/db/index.js';
import type { Store } from '../../../src/server/db/index.js';
import { createEventBus } from '../../../src/server/engine/bus.js';
import type { EventBus } from '../../../src/server/engine/bus.js';
import { buildCatalog } from '../../../src/server/engine/catalog.js';
import type { Catalog } from '../../../src/server/engine/catalog.js';
import { createEngine } from '../../../src/server/engine/index.js';
import type { Engine } from '../../../src/server/engine/index.js';
import { createLedger } from '../../../src/server/engine/ledger.js';
import type { Ledger } from '../../../src/server/engine/ledger.js';
import type { Clock, IdGenerator, Sleep } from '../../../src/server/engine/time.js';
import { silentLogger } from '../../../src/server/logger.js';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  Coordination,
  Executor,
  NormalisedSignal,
  StepContext,
  StepResult,
} from '../../../src/server/ports.js';

export const START = '2026-11-26T12:00:00.000Z';
export const MINUTE = 60_000;

/** A clock and a sleep that only move when the test says so. */
export class FakeTime {
  private current: number;
  private waiters: { due: number; wake: () => void }[] = [];

  constructor(start: string = START) {
    this.current = Date.parse(start);
  }

  readonly clock: Clock = () => new Date(this.current);

  readonly sleep: Sleep = (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const waiter = { due: this.current + ms, wake: resolve };
      this.waiters = [...this.waiters, waiter];
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve();
        },
        { once: true },
      );
    });

  /** Moves the clock forward and wakes every sleeper whose time has come. */
  advance(ms: number): void {
    this.current += ms;
    const due = this.waiters.filter((w) => w.due <= this.current);
    this.waiters = this.waiters.filter((w) => w.due > this.current);
    for (const waiter of due) waiter.wake();
  }

  sleepers(): number {
    return this.waiters.length;
  }
}

export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    token: null,
    isLoopback: true,
    dbPath: ':memory:',
    configDir: '/nonexistent/config',
    webDir: '/nonexistent/web',
    mode: 'live',
    workdir: '/srv/checkout',
    coordination: 'local',
    stepDelayMs: 0,
    concurrency: 2,
    allowedCommands: ['npm'],
    claudeBin: 'claude',
    codexBin: 'codex',
    sentrySecret: null,
    githubSecret: null,
    ...overrides,
  };
}

// ── Catalog fixtures ─────────────────────────────────────────────────────────

export function operator(id: string, harness: Harness = 'claude'): OperatorConfig {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    handle: `@${id}`,
    role: `${id} role`,
    instructions: `You are ${id}.`,
    harness,
  };
}

export const agentStep = (
  id: string,
  operatorId: string,
  extra: Partial<AgentStep> = {},
): AgentStep => ({
  id,
  kind: 'agent',
  title: `Do ${id}`,
  operator: operatorId,
  instruction: `Please do ${id}.`,
  ...extra,
});

export const commandStep = (
  id: string,
  run: string[],
  extra: Partial<CommandStep> = {},
): CommandStep => ({ id, kind: 'command', title: `Run ${id}`, run, ...extra });

export const gateStep = (id: string, onReject: 'stop' | 'continue' = 'stop'): GateStep => ({
  id,
  kind: 'gate',
  title: `Decide ${id}`,
  question: `Go ahead with ${id}?`,
  onReject,
});

export function playbook(id: string, steps: Step[], budget: Partial<Playbook['budget']> = {}): Playbook {
  return {
    id,
    name: `Playbook ${id}`,
    description: `Fixture playbook ${id}.`,
    version: 1,
    budget: { maxMinutes: 30, maxAgentSteps: 5, maxHandoffs: 3, ...budget },
    steps,
  };
}

export function watch(id: string, playbookId: string, extra: Partial<Watch> = {}): Watch {
  return {
    id,
    name: `Watch ${id}`,
    source: 'manual',
    kinds: [],
    match: {},
    playbookId,
    enabled: true,
    dedupeMinutes: 0,
    ...extra,
  };
}

export function catalogOf(parts: {
  operators?: OperatorConfig[];
  playbooks: Playbook[];
  watches?: Watch[];
  schedules?: Schedule[];
}): Catalog {
  return buildCatalog({
    operators: parts.operators ?? [operator('inspector'), operator('fitter', 'codex')],
    playbooks: parts.playbooks.map((p) => ({ file: `playbooks/${p.id}.json`, playbook: p })),
    watches: parts.watches ?? [],
    schedules: parts.schedules ?? [],
  });
}

export function signal(extra: Partial<NormalisedSignal> = {}): NormalisedSignal {
  return {
    source: 'manual',
    kind: 'manual.run',
    title: 'Checkout page throws on empty cart',
    fingerprint: 'checkout-empty-cart',
    url: null,
    severity: 'error',
    payload: {},
    ...extra,
  };
}

// ── Fakes for the ports ──────────────────────────────────────────────────────

export type ExecutorScript = (ctx: StepContext, abort: AbortSignal) => Promise<StepResult> | StepResult;

export const okResult = (summary = 'Done.', extra: Partial<StepResult> = {}): StepResult => ({
  ok: true,
  summary,
  artifacts: [],
  claims: [],
  ...extra,
});

export interface FakeExecutor extends Executor {
  calls: StepContext[];
  script: ExecutorScript;
}

export function fakeExecutor(harness: Harness, script?: ExecutorScript): FakeExecutor {
  const executor: FakeExecutor = {
    harness,
    calls: [],
    script: script ?? ((ctx) => okResult(`${ctx.operator.name} finished ${ctx.step.id}.`)),
    run: async (ctx, abort) => {
      executor.calls.push(ctx);
      return executor.script(ctx, abort);
    },
  };
  return executor;
}

/** Resolves never, and rejects the way a real session does when it is aborted. */
export function untilAborted(abort: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (abort.aborted) fail();
    else abort.addEventListener('abort', fail, { once: true });
  });
}

export interface FakeCommandRunner extends CommandRunner {
  calls: { argv: string[]; opts: CommandOptions }[];
  script: (argv: string[], opts: CommandOptions) => Promise<CommandResult> | CommandResult;
}

export const commandResult = (extra: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 0,
  output: 'all good',
  dryRun: false,
  timedOut: false,
  ...extra,
});

export function fakeCommandRunner(script?: FakeCommandRunner['script']): FakeCommandRunner {
  const runner: FakeCommandRunner = {
    calls: [],
    script: script ?? (() => commandResult()),
    run: async (argv, opts) => {
      runner.calls.push({ argv, opts });
      return runner.script(argv, opts);
    },
  };
  return runner;
}

export interface FakeCoordination extends Coordination {
  recalls: { operatorId: string; query: string; limit: number }[];
  remembered: { operatorId: string; key: string; text: string; tags: string[] }[];
  failRecall: boolean;
  failRemember: boolean;
}

export function fakeCoordination(): FakeCoordination {
  const coordination: FakeCoordination = {
    kind: 'local',
    recalls: [],
    remembered: [],
    failRecall: false,
    failRemember: false,
    recall: async (operatorId, query, limit) => {
      coordination.recalls.push({ operatorId, query, limit });
      if (coordination.failRecall) throw new Error('memory is offline');
      return [{ key: 'earlier', text: 'Seen something like this before.', score: 0.8 }];
    },
    remember: async (operatorId, key, text, tags) => {
      if (coordination.failRemember) throw new Error('memory is offline');
      coordination.remembered.push({ operatorId, key, text, tags });
    },
    route: async () => ({ tier: 2, reason: 'fixture' }),
    close: async () => undefined,
  };
  return coordination;
}

// ── A whole engine wired with fakes ──────────────────────────────────────────

export interface Rig {
  engine: Engine;
  store: Store;
  bus: EventBus;
  ledger: Ledger;
  catalog: Catalog;
  config: Config;
  time: FakeTime;
  events: StreamEvent[];
  executors: Record<Harness, FakeExecutor>;
  commands: FakeCommandRunner;
  coordination: FakeCoordination;
  /** The current state of a run; fails the test when it does not exist. */
  run(id: string): Run;
  /** Builds a second engine over the same store, as a restarted process would. */
  restart(): Rig;
}

export interface RigOptions {
  catalog: Catalog;
  config?: Partial<Config>;
  store?: Store;
  time?: FakeTime;
}

export function makeRig(options: RigOptions): Rig {
  const config = makeConfig(options.config);
  const store = options.store ?? createStore(':memory:');
  const time = options.time ?? new FakeTime();
  const bus = createEventBus(silentLogger);
  const newId = sequentialIdsFor(store);
  const ledger = createLedger(store, bus, time.clock, newId);
  const executors = {
    simulated: fakeExecutor('simulated'),
    claude: fakeExecutor('claude'),
    codex: fakeExecutor('codex'),
  };
  const commands = fakeCommandRunner();
  const coordination = fakeCoordination();
  const events: StreamEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const engine = createEngine({
    config,
    store,
    catalog: options.catalog,
    bus,
    ledger,
    executors,
    commandRunner: commands,
    coordination,
    log: silentLogger,
    clock: time.clock,
    newId,
    sleep: time.sleep,
  });
  return {
    engine,
    store,
    bus,
    ledger,
    catalog: options.catalog,
    config,
    time,
    events,
    executors,
    commands,
    coordination,
    run: (id) => store.runs.require(id),
    restart: () => makeRig({ ...options, store, time }),
  };
}

/** Ids that stay unique when a second engine is built over the same store. */
function sequentialIdsFor(store: Store): IdGenerator {
  const base = sequentialIds();
  const generation = store.timeline.count() + store.signals.count();
  return (prefix) => (generation === 0 ? base(prefix) : `${base(prefix)}r${generation}`);
}

// ── Small async helpers ──────────────────────────────────────────────────────

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets everything that is already scheduled run. */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
