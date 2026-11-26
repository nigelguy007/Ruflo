import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ConfigError } from '../../../src/server/config.js';
import { loadCatalog } from '../../../src/server/engine/catalog.js';
import { agentStep, gateStep, operator, playbook, watch } from './support.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Files {
  operators?: unknown;
  watches?: unknown;
  schedules?: unknown;
  playbooks?: Record<string, unknown>;
}

/** Writes a config directory; anything not given gets a small valid default. */
function configDir(files: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'switchyard-catalog-'));
  created.push(dir);
  mkdirSync(join(dir, 'playbooks'));
  const write = (name: string, value: unknown): void =>
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  write('operators.json', files.operators ?? [operator('inspector'), operator('fitter')]);
  write('watches.json', files.watches ?? []);
  write('schedules.json', files.schedules ?? []);
  const playbooks = files.playbooks ?? {
    'fix.json': playbook('fix', [agentStep('look', 'inspector'), gateStep('ok')]),
  };
  for (const [name, value] of Object.entries(playbooks)) write(join('playbooks', name), value);
  return dir;
}

function loadError(dir: string): ConfigError {
  try {
    loadCatalog(dir);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadCatalog to throw');
}

describe('loadCatalog', () => {
  test('loads the configuration that ships with the repository', () => {
    const catalog = loadCatalog(resolve(import.meta.dirname, '../../../config'));

    expect(catalog.operators.map((o) => o.id)).toEqual(['inspector', 'fitter', 'checker', 'dispatcher']);
    expect(catalog.playbooks.map((p) => p.id).sort()).toEqual([
      'error-to-fix',
      'nightly-dependency-check',
      'red-main',
      'review-pull-request',
    ]);
    expect(catalog.watches).toHaveLength(4);
    expect(catalog.schedules).toHaveLength(1);
    expect(catalog.playbook('error-to-fix')?.steps).toHaveLength(7);
    expect(catalog.operator('checker')?.handle).toBe('@checker');
    expect(catalog.watch('manual-error')?.playbookId).toBe('error-to-fix');
  });

  test('answers null for ids it does not know', () => {
    const catalog = loadCatalog(configDir());

    expect(catalog.operator('ghost')).toBeNull();
    expect(catalog.playbook('ghost')).toBeNull();
    expect(catalog.watch('ghost')).toBeNull();
  });

  test('rejects an agent step whose operator is not defined', () => {
    const dir = configDir({
      playbooks: { 'fix.json': playbook('fix', [agentStep('look', 'ghost')]) },
    });

    const error = loadError(dir);

    expect(error.message).toContain('playbooks/fix.json');
    expect(error.message).toContain('step "look"');
    expect(error.message).toContain('operator "ghost"');
  });

  test('rejects a handoff to an operator that is not defined', () => {
    const dir = configDir({
      playbooks: {
        'fix.json': playbook('fix', [agentStep('look', 'inspector', { handoffTo: 'nobody' })]),
      },
    });

    const error = loadError(dir);

    expect(error.message).toContain('playbooks/fix.json');
    expect(error.message).toContain('hands off to "nobody"');
  });

  test('rejects a watch that points at a playbook that does not exist', () => {
    const dir = configDir({ watches: [watch('orphan', 'missing-playbook')] });

    const error = loadError(dir);

    expect(error.message).toContain('watches.json');
    expect(error.message).toContain('watch "orphan"');
    expect(error.message).toContain('playbook "missing-playbook"');
  });

  test('rejects a schedule that points at a playbook that does not exist', () => {
    const dir = configDir({
      schedules: [
        { id: 'nightly', name: 'Nightly', playbookId: 'gone', enabled: true, everyMinutes: 60, dailyAt: null },
      ],
    });

    const error = loadError(dir);

    expect(error.message).toContain('schedules.json');
    expect(error.message).toContain('schedule "nightly"');
    expect(error.message).toContain('playbook "gone"');
  });

  test('names the file when it is not valid JSON', () => {
    const dir = configDir({ watches: '[{ not json' });

    expect(loadError(dir).message).toMatch(/^watches\.json: is not valid JSON/);
  });

  test('names the file and the field when a value breaks the schema', () => {
    const dir = configDir({ operators: [{ ...operator('inspector'), handle: 'no-at-sign' }] });

    const error = loadError(dir);

    expect(error.message).toMatch(/^operators\.json: /);
    expect(error.message).toContain('0.handle');
  });

  test('names the playbook file when a step is malformed', () => {
    const dir = configDir({
      playbooks: { 'broken.json': { ...playbook('broken', [gateStep('ok')]), budget: { maxMinutes: 0 } } },
    });

    expect(loadError(dir).message).toMatch(/^playbooks\/broken\.json: budget\./);
  });

  test('rejects two playbook files that claim the same id', () => {
    const dir = configDir({
      playbooks: {
        'a.json': playbook('same', [gateStep('ok')]),
        'b.json': playbook('same', [gateStep('ok')]),
      },
    });

    const error = loadError(dir);

    expect(error.message).toContain('playbooks/b.json');
    expect(error.message).toContain('already defined in playbooks/a.json');
  });

  test('rejects duplicate operator ids and handles', () => {
    const sameId = configDir({ operators: [operator('inspector'), operator('inspector')] });
    const sameHandle = configDir({
      operators: [operator('inspector'), { ...operator('fitter'), handle: '@inspector' }],
    });

    expect(loadError(sameId).message).toContain('operator id "inspector" is used more than once');
    expect(loadError(sameHandle).message).toContain('operator handle "@inspector" is used more than once');
  });

  test('says which file is missing', () => {
    const dir = configDir();
    rmSync(join(dir, 'schedules.json'));

    expect(loadError(dir).message).toMatch(/^schedules\.json: cannot be read/);
  });

  test('says when the playbooks directory is missing', () => {
    const dir = configDir();
    rmSync(join(dir, 'playbooks'), { recursive: true });

    expect(loadError(dir).message).toMatch(/^playbooks\/: cannot be read/);
  });
});
