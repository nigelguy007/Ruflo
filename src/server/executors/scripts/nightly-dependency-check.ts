import { simulatedLocation } from './types.js';
import type { PlaybookScripts } from './types.js';

/** Playbook "nightly-dependency-check": choose the upgrades worth doing, then prepare them. */
export const nightlyDependencyCheckScripts: PlaybookScripts = {
  triage: ({ title }) => ({
    ok: true,
    summary:
      `Read the audit output for "${title}" and chose two of the five advisories to act on. ` +
      'Both have a patch release that closes the advisory, and both sit in code this service runs in production. ' +
      'The other three need a major version jump or affect a build-only tool, so they are listed and left alone.',
    artifacts: [{ kind: 'log', label: 'Audit triage', value: simulatedLocation('log', 'audit-triage') }],
    claims: [
      {
        label: 'Chosen',
        detail: '2 patch upgrades, each closing one advisory in a code path the service uses.',
        ok: true,
      },
      {
        label: 'Left alone',
        detail: '3 advisories: 2 need a major version jump and 1 is in a tool that only runs at build time.',
        ok: null,
      },
      { label: 'Risk', detail: 'Neither changelog lists a breaking change.', ok: null },
    ],
  }),

  upgrade: ({ title }) => ({
    ok: true,
    summary:
      `Applied the two upgrades chosen for "${title}" on a new branch and opened one pull request. ` +
      'The lockfile changes cover those two packages and three packages they depend on, and nothing else. ' +
      'The suite passes on the branch and the audit now lists three advisories instead of five.',
    artifacts: [
      { kind: 'pr', label: 'Pull request', value: simulatedLocation('pull-request', 3) },
      { kind: 'diff', label: 'Diff', value: simulatedLocation('diff', 3) },
    ],
    claims: [
      {
        label: 'Lockfile',
        detail: '5 entries changed: the 2 chosen packages and 3 of their own dependencies.',
        ok: true,
      },
      {
        label: 'Advisories',
        detail: '5 before, 3 after; the remaining 3 are the ones triage left alone.',
        ok: true,
      },
      { label: 'Tests', detail: 'The suite passes on the upgrade branch.', ok: true },
    ],
  }),
};
