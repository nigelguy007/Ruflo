import { describe, expect, test } from 'vitest';
import { hmacSha256Hex } from '../../../src/server/signals/hmac.js';
import { sentryAdapter, severityFromLevel } from '../../../src/server/signals/sentry.js';

const SECRET = 'sentry-client-secret-for-tests';

/** Trimmed copy of the sample on Sentry's "Issue Webhooks" documentation page. */
function issueDelivery(overrides: Record<string, unknown> = {}, action = 'created'): unknown {
  return {
    action,
    installation: { uuid: '24b397fc-a86e-43ef-9297-949e21b82480' },
    data: {
      issue: {
        url: 'https://sentry.io/api/0/organizations/example-org/issues/1234567890/',
        web_url: 'https://example-org.sentry.io/issues/1234567890/',
        id: '1234567890',
        shortId: 'PYTHON-Y',
        title: 'TypeError: cart.total is undefined',
        culprit: 'checkout.views in submit_order',
        permalink: 'https://example-org.sentry.io/issues/1234567890/permalink/',
        level: 'fatal',
        status: 'unresolved',
        project: { id: '112313123123134', name: 'python', slug: 'python', platform: 'python' },
        count: '3',
        userCount: 3,
        ...overrides,
      },
    },
    actor: { type: 'application', id: 'sentry', name: 'Sentry' },
  };
}

const issueHeaders = { 'sentry-hook-resource': 'issue' };

describe('sentry verify', () => {
  test('accepts a delivery signed with the client secret', () => {
    // Arrange
    const rawBody = JSON.stringify(issueDelivery());
    const headers = { 'sentry-hook-signature': hmacSha256Hex(SECRET, rawBody) };

    // Act
    const verified = sentryAdapter.verify(rawBody, headers, SECRET);

    // Assert
    expect(verified).toBe(true);
  });

  test('rejects a body that was re-serialised after signing', () => {
    const rawBody = JSON.stringify(issueDelivery());
    const headers = { 'sentry-hook-signature': hmacSha256Hex(SECRET, rawBody) };
    const reserialised = JSON.stringify(JSON.parse(rawBody), null, 2);

    expect(sentryAdapter.verify(reserialised, headers, SECRET)).toBe(false);
  });

  test('rejects a delivery signed with another secret', () => {
    const rawBody = JSON.stringify(issueDelivery());
    const headers = { 'sentry-hook-signature': hmacSha256Hex('wrong', rawBody) };

    expect(sentryAdapter.verify(rawBody, headers, SECRET)).toBe(false);
  });

  test('rejects a delivery with no signature header', () => {
    expect(sentryAdapter.verify('{}', {}, SECRET)).toBe(false);
  });

  test('rejects a malformed signature without throwing', () => {
    expect(sentryAdapter.verify('{}', { 'sentry-hook-signature': 'sha256=abc' }, SECRET)).toBe(false);
    expect(sentryAdapter.verify('{}', { 'sentry-hook-signature': '' }, SECRET)).toBe(false);
  });

  test('returns false instead of throwing when the header map is not an object', () => {
    const broken = null as unknown as Record<string, string>;

    expect(sentryAdapter.verify('{}', broken, SECRET)).toBe(false);
  });
});

describe('sentry normalise: issues', () => {
  test('turns a created issue into an issue.created signal', () => {
    // Act
    const signal = sentryAdapter.normalise(issueDelivery(), issueHeaders);

    // Assert
    expect(signal).toEqual({
      source: 'sentry',
      kind: 'issue.created',
      title: 'TypeError: cart.total is undefined',
      fingerprint: 'sentry:1234567890',
      url: 'https://example-org.sentry.io/issues/1234567890/',
      severity: 'critical',
      payload: {
        issueId: '1234567890',
        shortId: 'PYTHON-Y',
        culprit: 'checkout.views in submit_order',
        project: 'python',
        level: 'fatal',
        count: 3,
        action: 'created',
      },
    });
  });

  test('uses the action in the kind for other issue deliveries', () => {
    const signal = sentryAdapter.normalise(issueDelivery({}, 'resolved'), issueHeaders);

    expect(signal?.kind).toBe('issue.resolved');
  });

  test('falls back to the permalink when there is no web url', () => {
    const signal = sentryAdapter.normalise(issueDelivery({ web_url: undefined }), issueHeaders);

    expect(signal?.url).toBe('https://example-org.sentry.io/issues/1234567890/permalink/');
  });

  test('drops a url that is not http or https', () => {
    const delivery = issueDelivery({ web_url: 'javascript:alert(1)', permalink: 'file:///etc/passwd' });

    expect(sentryAdapter.normalise(delivery, issueHeaders)?.url).toBeNull();
  });

  test('accepts a numeric issue id', () => {
    const signal = sentryAdapter.normalise(issueDelivery({ id: 42 }), issueHeaders);

    expect(signal?.fingerprint).toBe('sentry:42');
  });

  test('clips a very long title to 200 characters', () => {
    const signal = sentryAdapter.normalise(issueDelivery({ title: 'x'.repeat(900) }), issueHeaders);

    expect(signal?.title).toHaveLength(200);
  });

  test('names the issue by its short id when the title is blank', () => {
    const signal = sentryAdapter.normalise(issueDelivery({ title: '   ' }), issueHeaders);

    expect(signal?.title).toBe('Sentry issue PYTHON-Y');
  });

  test('reports a null count when Sentry sends something that is not a whole number', () => {
    const signal = sentryAdapter.normalise(issueDelivery({ count: 'many' }), issueHeaders);

    expect(signal?.payload.count).toBeNull();
  });

  test.each([
    ['fatal', 'critical'],
    ['error', 'error'],
    ['warning', 'warning'],
    ['info', 'info'],
    ['debug', 'info'],
    [undefined, 'info'],
  ])('maps level %s to severity %s', (level, severity) => {
    expect(severityFromLevel(level)).toBe(severity);
  });

  test.each([
    ['a missing data object', { action: 'created' }],
    ['an issue without an id', issueDelivery({ id: undefined })],
    ['an id with unexpected characters', issueDelivery({ id: '12/../34' })],
    ['a title that is not a string', issueDelivery({ title: { nested: true } })],
    ['an action that is not a plain word', issueDelivery({}, 'Created; DROP')],
    ['a body that is not an object', 'created'],
    ['a null body', null],
  ])('returns null for %s', (_name, body) => {
    expect(sentryAdapter.normalise(body, issueHeaders)).toBeNull();
  });
});

describe('sentry normalise: alerts', () => {
  const eventAlert = {
    action: 'triggered',
    data: {
      event: {
        event_id: 'e4874d664c3540c1a32eab185f12c5ab',
        issue_id: '1117540176',
        title: 'ReferenceError: heck is not defined',
        culprit: '?(<anonymous>)',
        level: 'error',
        web_url:
          'https://sentry.io/organizations/test-org/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/',
      },
      triggered_rule: 'Very Important Alert!',
    },
  };

  test('turns a triggered issue alert into alert.triggered for the underlying issue', () => {
    const signal = sentryAdapter.normalise(eventAlert, { 'sentry-hook-resource': 'event_alert' });

    expect(signal).toMatchObject({
      source: 'sentry',
      kind: 'alert.triggered',
      title: 'Very Important Alert!: ReferenceError: heck is not defined',
      fingerprint: 'sentry:1117540176',
      severity: 'error',
      payload: { issueId: '1117540176', rule: 'Very Important Alert!', action: 'triggered' },
    });
    expect(signal?.url).toContain('/issues/1117540176/events/');
  });

  test('fingerprints an issue alert by event id when the issue id is absent', () => {
    const delivery = {
      action: 'triggered',
      data: { event: { event_id: 'abc123', title: 'Boom' }, triggered_rule: null },
    };

    const signal = sentryAdapter.normalise(delivery, { 'sentry-hook-resource': 'event_alert' });

    expect(signal).toMatchObject({ fingerprint: 'sentry:event:abc123', title: 'Boom' });
  });

  test('ignores an issue alert that names neither an issue nor an event', () => {
    const delivery = { action: 'triggered', data: { event: { title: 'Boom' } } };

    expect(sentryAdapter.normalise(delivery, { 'sentry-hook-resource': 'event_alert' })).toBeNull();
  });

  function metricAlert(action: string): unknown {
    return {
      action,
      data: {
        description_text: '1000 events in the last 10 minutes',
        description_title: 'Critical: Too many errors',
        metric_alert: { id: '4', title: 'Sacred Marmot', alert_rule: { id: '7', name: 'Too many errors' } },
        web_url: 'https://sentry.io/organizations/baz/alerts/1/',
      },
    };
  }

  test('turns a critical metric alert into a critical alert.triggered signal', () => {
    const signal = sentryAdapter.normalise(metricAlert('critical'), {
      'sentry-hook-resource': 'metric_alert',
    });

    expect(signal).toEqual({
      source: 'sentry',
      kind: 'alert.triggered',
      title: 'Critical: Too many errors',
      fingerprint: 'sentry:metric-alert:7',
      url: 'https://sentry.io/organizations/baz/alerts/1/',
      severity: 'critical',
      payload: { alertRuleId: '7', incidentId: '4', rule: 'Too many errors', action: 'critical' },
    });
  });

  test('treats a warning metric alert as a warning', () => {
    const signal = sentryAdapter.normalise(metricAlert('warning'), {
      'sentry-hook-resource': 'metric_alert',
    });

    expect(signal?.severity).toBe('warning');
  });

  test('ignores a metric alert that resolved', () => {
    const signal = sentryAdapter.normalise(metricAlert('resolved'), {
      'sentry-hook-resource': 'metric_alert',
    });

    expect(signal).toBeNull();
  });

  test('ignores a metric alert with no rule or incident id', () => {
    const delivery = { action: 'critical', data: { metric_alert: { title: 'Nameless' } } };

    expect(sentryAdapter.normalise(delivery, { 'sentry-hook-resource': 'metric_alert' })).toBeNull();
  });
});

describe('sentry normalise: everything else', () => {
  test.each(['installation', 'error', 'comment', 'seer', 'preprod_artifact', 'something_new'])(
    'ignores the %s resource',
    (resource) => {
      const signal = sentryAdapter.normalise(issueDelivery(), { 'sentry-hook-resource': resource });

      expect(signal).toBeNull();
    },
  );

  test('ignores a delivery with no resource header', () => {
    expect(sentryAdapter.normalise(issueDelivery(), {})).toBeNull();
  });
});
