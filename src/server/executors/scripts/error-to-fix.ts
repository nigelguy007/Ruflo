import { simulatedLocation } from './types.js';
import type { PlaybookScripts } from './types.js';

/** Playbook "error-to-fix": reproduce, fix, review, then watch the rollout. */
export const errorToFixScripts: PlaybookScripts = {
  reproduce: ({ title }) => ({
    ok: true,
    summary:
      `Reproduced "${title}" on the default branch with a 14-line test that sends the request with the optional field left out. ` +
      "The handler reads that field two lines before it checks whether it exists, an ordering introduced by last week's refactor of the validation code. " +
      'About one request in forty takes that path, and it fails before anything is written.',
    artifacts: [{ kind: 'log', label: 'Reproduction output', value: simulatedLocation('log', 'reproduction') }],
    claims: [
      {
        label: 'Reproduction',
        detail: 'The new test fails 5 runs out of 5 on the default branch and passes on the commit before the refactor.',
        ok: true,
      },
      {
        label: 'Likely cause',
        detail: 'The existence check sits two lines below the first read of the field it guards.',
        ok: null,
      },
      {
        label: 'Who is affected',
        detail: '2.4% of requests to this route in the last hour; each fails before any write, so there is no data to repair.',
        ok: null,
      },
    ],
  }),

  fix: ({ title }) => ({
    ok: true,
    summary:
      `Opened a pull request for "${title}" with one regression test and a six-line change that moves the existence check above the first read. ` +
      'The test fails on the default branch and passes on the fix branch. ' +
      'No other file changed.',
    artifacts: [
      { kind: 'pr', label: 'Pull request', value: simulatedLocation('pull-request', 1) },
      { kind: 'diff', label: 'Diff', value: simulatedLocation('diff', 1) },
    ],
    claims: [
      { label: 'Regression test', detail: 'Fails on the default branch, passes on the fix branch.', ok: true },
      {
        label: 'Size of change',
        detail: '2 files: 6 lines added and 1 removed in the handler, plus a 22-line test.',
        ok: null,
      },
      { label: 'Scope', detail: 'No dependency, configuration or public interface changed.', ok: true },
    ],
  }),

  review: ({ title }) => ({
    ok: true,
    summary:
      `Reviewed the pull request for "${title}" in a fresh session, without the author's notes. ` +
      'The change fixes the stated cause, and with the fix reverted the new test fails again, so the test would catch a regression. ' +
      'One finding that does not block the merge: rejected requests are not logged.',
    artifacts: [{ kind: 'log', label: 'Review notes', value: simulatedLocation('review', 1) }],
    claims: [
      {
        label: 'Fix matches the cause',
        detail: 'The check now runs before the first read of the field, and no other path reads it earlier.',
        ok: true,
      },
      {
        label: 'Test would catch a regression',
        detail: 'Fails with the fix reverted, passes with it applied.',
        ok: true,
      },
      { label: 'Unrelated changes', detail: 'None. The diff stays inside the handler and its test.', ok: true },
      {
        label: 'Finding',
        detail: 'Not blocking: the new early return does not log the rejected request, which will make the next report harder to trace.',
        ok: null,
      },
    ],
  }),

  watch: ({ title }) => ({
    ok: true,
    summary:
      `The fix for "${title}" reached every instance after a nine-minute rolling deploy. ` +
      "In the 15 minutes since, the route's error rate fell from 2.4% to 0.1% and the error has not come back. " +
      'Latency did not move, so there is no reason to roll back.',
    artifacts: [{ kind: 'log', label: 'Rollout comparison', value: simulatedLocation('rollout', 1) }],
    claims: [
      {
        label: 'Error rate',
        detail: '2.4% in the hour before the deploy, 0.1% in the 15 minutes after it finished.',
        ok: true,
      },
      {
        label: 'Latency',
        detail: 'Median 118 ms before and after; 95th percentile 412 ms before, 405 ms after.',
        ok: true,
      },
      { label: 'Recurrence', detail: 'No new events for this error since the deploy finished.', ok: true },
    ],
  }),
};
