import { simulatedLocation } from './types.js';
import type { PlaybookScripts } from './types.js';

/** Playbook "red-main": find what broke the default branch, then prepare the fix. */
export const redMainScripts: PlaybookScripts = {
  diagnose: ({ title }) => ({
    ok: true,
    summary:
      `"${title}" started with the most recent merge to the default branch. ` +
      'That commit renamed a shared helper and missed one caller, so the build stops at the type check before any test runs. ' +
      'The parent commit passes the same check, which rules out a flaky runner.',
    artifacts: [{ kind: 'log', label: 'Failing check output', value: simulatedLocation('log', 'failing-check') }],
    claims: [
      {
        label: 'Breaking commit',
        detail: 'The latest merge to the default branch; its parent passes the same check.',
        ok: true,
      },
      { label: 'Reason', detail: 'One module still imports the helper under its old name.', ok: null },
      { label: 'Not flaky', detail: 'Re-running the check on the same commit failed 3 times out of 3.', ok: true },
    ],
  }),

  fix: ({ title }) => ({
    ok: true,
    summary:
      `Opened a pull request for "${title}" that points the missed caller at the helper's new name. ` +
      'The type check and the full suite pass on the fix branch. ' +
      'A nine-line test now imports the helper by name, so the next rename fails in review instead of on the default branch.',
    artifacts: [
      { kind: 'pr', label: 'Pull request', value: simulatedLocation('pull-request', 2) },
      { kind: 'diff', label: 'Diff', value: simulatedLocation('diff', 2) },
    ],
    claims: [
      {
        label: 'Check passes',
        detail: 'The failing check passes on the fix branch and still fails on the default branch.',
        ok: true,
      },
      { label: 'Size of change', detail: '1 import changed and one 9-line test added.', ok: null },
      {
        label: 'Behaviour',
        detail: 'Unchanged; the caller reaches the same function under its new name.',
        ok: true,
      },
    ],
  }),
};
