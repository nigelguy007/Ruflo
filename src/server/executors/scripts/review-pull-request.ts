import { simulatedLocation } from './types.js';
import type { PlaybookScripts } from './types.js';

/** Playbook "review-pull-request": one read-only review of a newly opened pull request. */
export const reviewPullRequestScripts: PlaybookScripts = {
  review: ({ title }) => ({
    ok: true,
    summary:
      `Reviewed "${title}" in a fresh session. ` +
      'The change does what its description says and the added tests cover both sides of the new condition. ' +
      'Two findings: the new error handler drops the original exception, and one test name still describes the old behaviour.',
    artifacts: [{ kind: 'log', label: 'Review notes', value: simulatedLocation('review', 2) }],
    claims: [
      {
        label: 'Finding 1',
        detail: 'The new catch block throws a generic error and loses the original one; pass it along as the cause.',
        ok: false,
      },
      {
        label: 'Finding 2',
        detail: 'One test is still named after the old behaviour, so a failure would read wrongly.',
        ok: null,
      },
      {
        label: 'Coverage',
        detail: 'Both sides of the new condition are exercised by the added tests.',
        ok: true,
      },
      {
        label: 'Unrelated changes',
        detail: 'None. Every changed line belongs to the feature or to its tests.',
        ok: true,
      },
    ],
  }),
};
