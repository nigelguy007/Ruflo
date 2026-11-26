import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { startupWarnings } from '../../src/server/warnings.js';

const LIVE = { SWITCHYARD_MODE: 'live', SWITCHYARD_WORKDIR: '/tmp' };
const real = [{ id: 'fitter', harness: 'claude' }];
const scripted = [
  { id: 'inspector', harness: 'simulated' },
  { id: 'fitter', harness: 'simulated' },
  { id: 'checker', harness: 'claude' },
];

describe('startup warnings', () => {
  test('simulate mode has nothing to warn about, whatever the operators use', () => {
    expect(startupWarnings(loadConfig({}), scripted)).toEqual([]);
  });

  test('live mode always says the sessions are not sandboxed', () => {
    const warnings = startupWarnings(loadConfig({ ...LIVE, SWITCHYARD_TOKEN: 'x'.repeat(24) }), real);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no sandbox');
    expect(warnings[0]).toContain('approve gates');
  });

  test('live mode without a token says any local process can approve, and that a token is not a sandbox', () => {
    const warnings = startupWarnings(loadConfig(LIVE), real);

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('SWITCHYARD_TOKEN');
    expect(warnings[1]).toContain('not a sandbox');
  });

  test('live mode names the operators that still use the scripted harness', () => {
    const warnings = startupWarnings(loadConfig({ ...LIVE, SWITCHYARD_TOKEN: 'x'.repeat(24) }), scripted);

    const scriptedWarning = warnings.find((w) => w.includes('scripted'));
    expect(scriptedWarning).toContain('inspector, fitter');
    expect(scriptedWarning).not.toContain('checker');
  });
});
