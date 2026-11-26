import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  operatorsFileSchema,
  playbookSchema,
  schedulesFileSchema,
  watchesFileSchema,
} from '../../shared/schemas.js';
import type { OperatorConfig } from '../../shared/schemas.js';
import type { Id, Playbook, Schedule, Watch } from '../../shared/types.js';
import { ConfigError } from '../config.js';
import { errorMessage } from '../logger.js';

const OPERATORS_FILE = 'operators.json';
const WATCHES_FILE = 'watches.json';
const SCHEDULES_FILE = 'schedules.json';
const PLAYBOOKS_DIR = 'playbooks';

/** A playbook together with the file it came from, for error messages. */
export interface PlaybookSource {
  file: string;
  playbook: Playbook;
}

export interface CatalogParts {
  operators: OperatorConfig[];
  playbooks: PlaybookSource[];
  watches: Watch[];
  schedules: Schedule[];
}

/** The validated contents of the config directory. Read once at boot and never mutated. */
export interface Catalog {
  readonly operators: readonly OperatorConfig[];
  readonly playbooks: readonly Playbook[];
  readonly watches: readonly Watch[];
  readonly schedules: readonly Schedule[];
  operator(id: Id): OperatorConfig | null;
  playbook(id: Id): Playbook | null;
  watch(id: Id): Watch | null;
}

function readJson(configDir: string, file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, file), 'utf8');
  } catch (error) {
    throw new ConfigError(`${file}: cannot be read (${errorMessage(error)})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${file}: is not valid JSON (${errorMessage(error)})`);
  }
}

function parseFile<T>(configDir: string, file: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(readJson(configDir, file));
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${where}${issue.message}`;
  });
  throw new ConfigError(`${file}: ${problems.join('; ')}`);
}

function listPlaybookFiles(configDir: string): string[] {
  try {
    return readdirSync(join(configDir, PLAYBOOKS_DIR))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => `${PLAYBOOKS_DIR}/${name}`);
  } catch (error) {
    throw new ConfigError(`${PLAYBOOKS_DIR}/: cannot be read (${errorMessage(error)})`);
  }
}

function assertUniqueIds(file: string, what: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ConfigError(`${file}: ${what} "${id}" is used more than once`);
    seen.add(id);
  }
}

function assertUniquePlaybooks(sources: readonly PlaybookSource[]): void {
  const firstFile = new Map<string, string>();
  for (const { file, playbook } of sources) {
    const earlier = firstFile.get(playbook.id);
    if (earlier !== undefined) {
      throw new ConfigError(`${file}: playbook id "${playbook.id}" is already defined in ${earlier}`);
    }
    firstFile.set(playbook.id, file);
  }
}

function assertStepOperators(source: PlaybookSource, operatorIds: ReadonlySet<string>): void {
  for (const step of source.playbook.steps) {
    if (step.kind !== 'agent') continue;
    if (!operatorIds.has(step.operator)) {
      throw new ConfigError(
        `${source.file}: step "${step.id}" names operator "${step.operator}", which is not defined in ${OPERATORS_FILE}`,
      );
    }
    if (step.handoffTo !== undefined && !operatorIds.has(step.handoffTo)) {
      throw new ConfigError(
        `${source.file}: step "${step.id}" hands off to "${step.handoffTo}", which is not defined in ${OPERATORS_FILE}`,
      );
    }
  }
}

function assertPlaybookRefs(
  file: string,
  what: string,
  entries: readonly { id: string; playbookId: string }[],
  playbookIds: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    if (!playbookIds.has(entry.playbookId)) {
      throw new ConfigError(
        `${file}: ${what} "${entry.id}" points at playbook "${entry.playbookId}", which does not exist in ${PLAYBOOKS_DIR}/`,
      );
    }
  }
}

/** Cross-checks every reference between the config files and builds the lookup tables. */
export function buildCatalog(parts: CatalogParts): Catalog {
  const playbooks = parts.playbooks.map((source) => source.playbook);
  assertUniqueIds(OPERATORS_FILE, 'operator id', parts.operators.map((o) => o.id));
  assertUniqueIds(OPERATORS_FILE, 'operator handle', parts.operators.map((o) => o.handle));
  assertUniqueIds(WATCHES_FILE, 'watch id', parts.watches.map((w) => w.id));
  assertUniqueIds(SCHEDULES_FILE, 'schedule id', parts.schedules.map((s) => s.id));
  assertUniquePlaybooks(parts.playbooks);

  const operatorsById = new Map(parts.operators.map((o) => [o.id, o]));
  const playbooksById = new Map(playbooks.map((p) => [p.id, p]));
  const watchesById = new Map(parts.watches.map((w) => [w.id, w]));
  const operatorIds = new Set(operatorsById.keys());
  const playbookIds = new Set(playbooksById.keys());

  for (const source of parts.playbooks) assertStepOperators(source, operatorIds);
  assertPlaybookRefs(WATCHES_FILE, 'watch', parts.watches, playbookIds);
  assertPlaybookRefs(SCHEDULES_FILE, 'schedule', parts.schedules, playbookIds);

  return {
    operators: parts.operators,
    playbooks,
    watches: parts.watches,
    schedules: parts.schedules,
    operator: (id) => operatorsById.get(id) ?? null,
    playbook: (id) => playbooksById.get(id) ?? null,
    watch: (id) => watchesById.get(id) ?? null,
  };
}

/** Loads and validates the config directory. Throws ConfigError naming the file and the problem. */
export function loadCatalog(configDir: string): Catalog {
  const playbooks = listPlaybookFiles(configDir).map((file) => ({
    file,
    playbook: parseFile<Playbook>(configDir, file, playbookSchema),
  }));
  return buildCatalog({
    operators: parseFile(configDir, OPERATORS_FILE, operatorsFileSchema),
    playbooks,
    watches: parseFile<Watch[]>(configDir, WATCHES_FILE, watchesFileSchema),
    schedules: parseFile<Schedule[]>(configDir, SCHEDULES_FILE, schedulesFileSchema),
  });
}
