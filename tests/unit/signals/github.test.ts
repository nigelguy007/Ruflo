import { describe, expect, test } from 'vitest';
import { githubAdapter } from '../../../src/server/signals/github.js';
import { hmacSha256Hex } from '../../../src/server/signals/hmac.js';
import { signalAdapters } from '../../../src/server/signals/index.js';

const SECRET = "It's a Secret to Everybody";

const repository = {
  id: 1,
  name: 'api',
  full_name: 'acme/api',
  private: true,
  default_branch: 'main',
};
const sender = { login: 'octocat', id: 2 };

function pullRequestDelivery(action = 'opened', overrides: Record<string, unknown> = {}): unknown {
  return {
    action,
    number: 12,
    pull_request: {
      title: 'Guard the empty cart total',
      html_url: 'https://github.com/acme/api/pull/12',
      draft: false,
      head: { label: 'acme:fix/cart-total', ref: 'fix/cart-total', sha: 'a1b2c3d4' },
      base: { label: 'acme:main', ref: 'main', sha: 'ffff0000' },
    },
    repository,
    sender,
    ...overrides,
  };
}

function checkRunDelivery(overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}): unknown {
  return {
    action: 'completed',
    check_run: {
      id: 99,
      name: 'unit-tests',
      head_sha: 'deadbeef',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/api/runs/99',
      details_url: 'https://ci.example.com/builds/99',
      check_suite: { id: 5, head_branch: 'main', head_sha: 'deadbeef' },
      pull_requests: [],
      ...overrides,
    },
    repository,
    sender,
    ...top,
  };
}

function workflowRunDelivery(overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}): unknown {
  return {
    action: 'completed',
    workflow: { id: 7, name: 'CI' },
    workflow_run: {
      id: 501,
      name: 'CI',
      head_branch: 'main',
      head_sha: 'cafef00d',
      status: 'completed',
      conclusion: 'failure',
      event: 'push',
      html_url: 'https://github.com/acme/api/actions/runs/501',
      head_repository: { full_name: 'acme/api' },
      ...overrides,
    },
    repository,
    sender,
    ...top,
  };
}

const event = (name: string): Record<string, string> => ({ 'x-github-event': name });

describe('github verify', () => {
  test('accepts the signature GitHub publishes for its sample payload', () => {
    // Arrange
    const headers = {
      'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    };

    // Act
    const verified = githubAdapter.verify('Hello, World!', headers, SECRET);

    // Assert
    expect(verified).toBe(true);
  });

  test('accepts a real-looking delivery signed with the webhook secret', () => {
    const rawBody = JSON.stringify(pullRequestDelivery());
    const headers = { 'x-hub-signature-256': `sha256=${hmacSha256Hex(SECRET, rawBody)}` };

    expect(githubAdapter.verify(rawBody, headers, SECRET)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const rawBody = JSON.stringify(pullRequestDelivery());
    const headers = { 'x-hub-signature-256': `sha256=${hmacSha256Hex(SECRET, rawBody)}` };

    expect(githubAdapter.verify(rawBody.replace('12', '13'), headers, SECRET)).toBe(false);
  });

  test('rejects a bare digest without the sha256= prefix', () => {
    const rawBody = 'Hello, World!';
    const headers = { 'x-hub-signature-256': hmacSha256Hex(SECRET, rawBody) };

    expect(githubAdapter.verify(rawBody, headers, SECRET)).toBe(false);
  });

  test('rejects the legacy SHA-1 header on its own', () => {
    const headers = { 'x-hub-signature': 'sha1=01dc10d0c83e72ed246219cdd91669667fe2ca59' };

    expect(githubAdapter.verify('Hello, World!', headers, SECRET)).toBe(false);
  });

  test('rejects a missing, truncated or non-hex signature without throwing', () => {
    expect(githubAdapter.verify('x', {}, SECRET)).toBe(false);
    expect(githubAdapter.verify('x', { 'x-hub-signature-256': 'sha256=abcd' }, SECRET)).toBe(false);
    expect(githubAdapter.verify('x', { 'x-hub-signature-256': `sha256=${'g'.repeat(64)}` }, SECRET)).toBe(false);
    expect(githubAdapter.verify('x', { 'x-hub-signature-256': 'sha256=' }, SECRET)).toBe(false);
  });

  test('returns false instead of throwing when the header map is not an object', () => {
    const broken = undefined as unknown as Record<string, string>;

    expect(githubAdapter.verify('x', broken, SECRET)).toBe(false);
  });
});

describe('github normalise: pull requests', () => {
  test('turns an opened pull request into pull_request.opened', () => {
    // Act
    const signal = githubAdapter.normalise(pullRequestDelivery(), event('pull_request'));

    // Assert
    expect(signal).toEqual({
      source: 'github',
      kind: 'pull_request.opened',
      title: 'PR #12: Guard the empty cart total',
      fingerprint: 'github:acme/api:pr:12',
      url: 'https://github.com/acme/api/pull/12',
      severity: 'info',
      payload: {
        repository: { name: 'api', full_name: 'acme/api' },
        number: 12,
        sha: 'a1b2c3d4',
        branch: 'fix/cart-total',
        sender: { login: 'octocat' },
        action: 'opened',
      },
    });
  });

  test.each(['reopened', 'ready_for_review'])('treats %s as pull_request.opened', (action) => {
    const signal = githubAdapter.normalise(pullRequestDelivery(action), event('pull_request'));

    expect(signal?.kind).toBe('pull_request.opened');
    expect(signal?.payload.action).toBe(action);
  });

  test.each(['closed', 'synchronize', 'edited', 'labeled', 'converted_to_draft'])(
    'ignores the %s action',
    (action) => {
      expect(githubAdapter.normalise(pullRequestDelivery(action), event('pull_request'))).toBeNull();
    },
  );

  test('reports a null sender login when GitHub omits the sender', () => {
    const delivery = pullRequestDelivery('opened', { sender: undefined });

    const signal = githubAdapter.normalise(delivery, event('pull_request'));

    expect(signal?.payload.sender).toEqual({ login: null });
  });

  test.each([
    ['a missing repository', pullRequestDelivery('opened', { repository: undefined })],
    ['a number that is not an integer', pullRequestDelivery('opened', { number: '12' })],
    ['a pull request without a head', pullRequestDelivery('opened', { pull_request: { title: 'x' } })],
    ['a body that is an array', []],
  ])('returns null for %s', (_name, body) => {
    expect(githubAdapter.normalise(body, event('pull_request'))).toBeNull();
  });
});

describe('github normalise: failed checks on the default branch', () => {
  test('turns a failed check run on the default branch into check_run.failed', () => {
    // Act
    const signal = githubAdapter.normalise(checkRunDelivery(), event('check_run'));

    // Assert
    expect(signal).toEqual({
      source: 'github',
      kind: 'check_run.failed',
      title: 'unit-tests failed on main in acme/api',
      fingerprint: 'github:acme/api:check:unit-tests:main',
      url: 'https://github.com/acme/api/runs/99',
      severity: 'error',
      payload: {
        repository: { name: 'api', full_name: 'acme/api' },
        number: null,
        sha: 'deadbeef',
        branch: 'main',
        sender: { login: 'octocat' },
        check: 'unit-tests',
        conclusion: 'failure',
      },
    });
  });

  test('treats a timed out check run as failed', () => {
    const signal = githubAdapter.normalise(checkRunDelivery({ conclusion: 'timed_out' }), event('check_run'));

    expect(signal?.kind).toBe('check_run.failed');
    expect(signal?.payload.conclusion).toBe('timed_out');
  });

  test.each(['success', 'neutral', 'cancelled', 'skipped', 'action_required', 'stale', null])(
    'ignores a check run that concluded %s',
    (conclusion) => {
      expect(githubAdapter.normalise(checkRunDelivery({ conclusion }), event('check_run'))).toBeNull();
    },
  );

  test('ignores a failed check run on a feature branch', () => {
    const delivery = checkRunDelivery({ check_suite: { head_branch: 'fix/cart-total' } });

    expect(githubAdapter.normalise(delivery, event('check_run'))).toBeNull();
  });

  test('ignores a failed check run from a fork, where GitHub sends a null head branch', () => {
    const delivery = checkRunDelivery({ check_suite: { head_branch: null } });

    expect(githubAdapter.normalise(delivery, event('check_run'))).toBeNull();
  });

  test('ignores a check run that has not completed', () => {
    const delivery = checkRunDelivery({}, { action: 'created' });

    expect(githubAdapter.normalise(delivery, event('check_run'))).toBeNull();
  });

  test('ignores a failed check run when the repository does not name its default branch', () => {
    const delivery = checkRunDelivery({}, { repository: { name: 'api', full_name: 'acme/api' } });

    expect(githubAdapter.normalise(delivery, event('check_run'))).toBeNull();
  });

  test('turns a failed workflow run on the default branch into check_run.failed', () => {
    const signal = githubAdapter.normalise(workflowRunDelivery(), event('workflow_run'));

    expect(signal).toMatchObject({
      kind: 'check_run.failed',
      severity: 'error',
      title: 'CI failed on main in acme/api',
      fingerprint: 'github:acme/api:check:CI:main',
      url: 'https://github.com/acme/api/actions/runs/501',
      payload: { sha: 'cafef00d', branch: 'main', check: 'CI', number: null },
    });
  });

  test('ignores a successful workflow run', () => {
    const delivery = workflowRunDelivery({ conclusion: 'success' });

    expect(githubAdapter.normalise(delivery, event('workflow_run'))).toBeNull();
  });

  test('ignores a failed workflow run on another branch', () => {
    const delivery = workflowRunDelivery({ head_branch: 'release/2' });

    expect(githubAdapter.normalise(delivery, event('workflow_run'))).toBeNull();
  });

  test('ignores a failed workflow run from a fork whose branch is also called main', () => {
    const delivery = workflowRunDelivery({ head_repository: { full_name: 'stranger/api' } });

    expect(githubAdapter.normalise(delivery, event('workflow_run'))).toBeNull();
  });

  test('ignores a workflow run that was only requested', () => {
    const delivery = workflowRunDelivery({ conclusion: null }, { action: 'requested' });

    expect(githubAdapter.normalise(delivery, event('workflow_run'))).toBeNull();
  });

  test('returns null for a workflow run delivery with an unexpected shape', () => {
    expect(githubAdapter.normalise({ action: 'completed', workflow_run: 7 }, event('workflow_run'))).toBeNull();
  });
});

describe('github normalise: everything else', () => {
  test('ignores a ping', () => {
    const ping = { zen: 'Keep it logically awesome.', hook_id: 1, hook: { type: 'Repository' }, repository };

    expect(githubAdapter.normalise(ping, event('ping'))).toBeNull();
  });

  test('ignores a push', () => {
    const push = { ref: 'refs/heads/main', before: 'a', after: 'b', repository, sender };

    expect(githubAdapter.normalise(push, event('push'))).toBeNull();
  });

  test.each(['issues', 'star', 'check_suite', 'something_new'])('ignores the %s event', (name) => {
    expect(githubAdapter.normalise(pullRequestDelivery(), event(name))).toBeNull();
  });

  test('ignores a delivery with no event header', () => {
    expect(githubAdapter.normalise(pullRequestDelivery(), {})).toBeNull();
  });
});

describe('signalAdapters', () => {
  test('exposes one adapter per provider under its source name', () => {
    expect(signalAdapters.sentry.source).toBe('sentry');
    expect(signalAdapters.github.source).toBe('github');
  });
});
