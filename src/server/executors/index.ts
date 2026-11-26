import type { Harness } from '../../shared/types.js';
import type { Config } from '../config.js';
import type { CommandRunner, Executor, Logger } from '../ports.js';
import { claudeProfile, codexProfile, createCliExecutor } from './cli.js';
import { createDryRunCommandRunner, createLiveCommandRunner } from './command-runner.js';
import { createSimulatedExecutor } from './simulated.js';

/**
 * One executor per harness.
 *
 * In simulate mode every harness is backed by the scripted executor, so an
 * operator configured for Claude or Codex still cannot start a real session,
 * spend quota or touch a checkout. Real sessions exist only in live mode.
 */
export function createExecutors(config: Config, log: Logger): Record<Harness, Executor> {
  const simulated = createSimulatedExecutor(config.stepDelayMs);
  if (config.mode !== 'live') {
    return {
      simulated,
      claude: createSimulatedExecutor(config.stepDelayMs, 'claude'),
      codex: createSimulatedExecutor(config.stepDelayMs, 'codex'),
    };
  }
  return {
    simulated,
    claude: createCliExecutor(claudeProfile(config), log),
    codex: createCliExecutor(codexProfile(config), log),
  };
}

/** Dry runs in simulate mode; allow-listed, shell-free execution in live mode. */
export function createCommandRunner(config: Config, log: Logger): CommandRunner {
  return config.mode === 'live' ? createLiveCommandRunner(config, log) : createDryRunCommandRunner(config);
}
