import { errorToFixScripts } from './error-to-fix.js';
import { nightlyDependencyCheckScripts } from './nightly-dependency-check.js';
import { redMainScripts } from './red-main.js';
import { reviewPullRequestScripts } from './review-pull-request.js';
import { simulatedLocation } from './types.js';
import type { PlaybookScripts, StepScript } from './types.js';

/** Scripts for the seed playbooks in config/playbooks, keyed by playbook id then step id. */
const SCRIPTS: Readonly<Record<string, PlaybookScripts>> = {
  'error-to-fix': errorToFixScripts,
  'red-main': redMainScripts,
  'nightly-dependency-check': nightlyDependencyCheckScripts,
  'review-pull-request': reviewPullRequestScripts,
};

/**
 * For playbooks and steps nobody wrote a script for: a result assembled from
 * the step, the operator and the signal, which says plainly that it is generic.
 */
export const fallbackScript: StepScript = ({ title, ctx }) => {
  const { step, operator, run, prior } = ctx;
  const earlier =
    prior.length === 0 ? 'It is the first step of the run.' : `It follows ${prior.length} earlier step${prior.length === 1 ? '' : 's'} in this run.`;
  return {
    ok: true,
    summary:
      `${operator.name} worked through "${step.title}" for "${title}" and reported back. ${earlier} ` +
      'This is the generic simulated result: no session ran and nothing was changed.',
    artifacts: [
      { kind: 'log', label: 'Simulated session', value: simulatedLocation('session', run.playbookId, step.id) },
    ],
    claims: [
      {
        label: 'Simulated step',
        detail: `No script is written for step "${step.id}" of playbook "${run.playbookId}", so this result is built from the step, the operator and the signal.`,
        ok: null,
      },
    ],
  };
};

export function scriptFor(playbookId: string, stepId: string): StepScript {
  const playbook = Object.hasOwn(SCRIPTS, playbookId) ? SCRIPTS[playbookId] : undefined;
  const script = playbook && Object.hasOwn(playbook, stepId) ? playbook[stepId] : undefined;
  return script ?? fallbackScript;
}
