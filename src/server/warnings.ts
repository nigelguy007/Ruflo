import type { Config } from './config.js';

export interface OperatorHarness {
  id: string;
  harness: string;
}

/**
 * Things worth saying out loud at start-up, each one plain sentence a person can
 * act on. Simulate mode changes no code, so it has nothing to warn about.
 */
export function startupWarnings(config: Config, operators: readonly OperatorHarness[]): string[] {
  if (config.mode !== 'live') return [];
  const warnings = [
    'Live mode runs agent sessions and test commands as this user, with no sandbox. Code an agent writes in the checkout also runs as this user and can call this server, including to approve gates. Use live mode only on repositories and signal sources you trust.',
  ];
  if (config.token === null) {
    warnings.push(
      'No SWITCHYARD_TOKEN is set, so any local process can approve gates and start runs. A token raises the bar, but code running as the same user can still read this process, so it is not a sandbox.',
    );
  }
  const scripted = operators.filter((o) => o.harness === 'simulated').map((o) => o.id);
  if (scripted.length > 0) {
    warnings.push(
      `Operators ${scripted.join(', ')} use the scripted "simulated" harness. In live mode their steps still produce scripted output, labelled simulated. Set "harness" to "claude" or "codex" in config/operators.json for real work.`,
    );
  }
  return warnings;
}
