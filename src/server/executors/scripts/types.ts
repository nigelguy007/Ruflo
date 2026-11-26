import type { StepContext, StepResult } from '../../ports.js';

/** What a scripted step gets to work with. */
export interface Scene {
  /** The signal title, shortened so it reads well inside a sentence. */
  title: string;
  ctx: StepContext;
}

/** A deterministic, hand-written result for one agent step. */
export type StepScript = (scene: Scene) => StepResult;

/** Step id → script, for one playbook. */
export type PlaybookScripts = Readonly<Record<string, StepScript>>;

/**
 * Artifacts from simulate mode point at a scheme no browser resolves, so they
 * can never be mistaken for a real pull request or log.
 */
export function simulatedLocation(...path: (string | number)[]): string {
  return `simulated://${path.join('/')}`;
}
