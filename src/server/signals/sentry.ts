import { z } from 'zod';
import type { Severity } from '../../shared/types.js';
import type { NormalisedSignal, SignalAdapter } from '../ports.js';
import { verifyHmacSha256 } from './hmac.js';
import { clip, firstHttpUrl, header } from './text.js';

/**
 * Sentry integration-platform webhooks.
 *
 * The signature is the hex HMAC-SHA256 of the raw body keyed with the
 * integration's client secret, sent in `Sentry-Hook-Signature`. The kind of
 * delivery is in `Sentry-Hook-Resource`.
 */

const SIGNATURE_HEADER = 'sentry-hook-signature';
const RESOURCE_HEADER = 'sentry-hook-resource';

/** Sentry ids are numeric strings; accept a narrow safe alphabet and nothing else. */
const identifier = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((value) => String(value))
  .pipe(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/));

const optionalText = z.string().nullish();

const issueDelivery = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  data: z.object({
    issue: z.object({
      id: identifier,
      title: z.string(),
      shortId: optionalText,
      culprit: optionalText,
      web_url: optionalText,
      permalink: optionalText,
      level: optionalText,
      count: z.union([z.string(), z.number()]).nullish(),
      project: z.object({ slug: optionalText }).nullish(),
    }),
  }),
});

const eventAlertDelivery = z.object({
  action: z.literal('triggered'),
  data: z.object({
    event: z.object({
      event_id: identifier.nullish(),
      issue_id: identifier.nullish(),
      title: optionalText,
      culprit: optionalText,
      level: optionalText,
      web_url: optionalText,
    }),
    triggered_rule: optionalText,
  }),
});

const metricAlertDelivery = z.object({
  action: z.enum(['critical', 'warning', 'resolved']),
  data: z.object({
    description_title: optionalText,
    web_url: optionalText,
    metric_alert: z.object({
      id: identifier.nullish(),
      title: optionalText,
      alert_rule: z.object({ id: identifier.nullish(), name: optionalText }).nullish(),
    }),
  }),
});

export function severityFromLevel(level: string | null | undefined): Severity {
  switch (level?.toLowerCase()) {
    case 'fatal':
      return 'critical';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

/** Sentry sends `count` as a decimal string; keep it only when it is a whole number. */
function wholeNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normaliseIssue(body: unknown): NormalisedSignal | null {
  const parsed = issueDelivery.safeParse(body);
  if (!parsed.success) return null;
  const { action, data } = parsed.data;
  const { issue } = data;
  const title = clip(issue.title);

  return {
    source: 'sentry',
    kind: `issue.${action}`,
    title: title.length > 0 ? title : `Sentry issue ${issue.shortId ?? issue.id}`,
    fingerprint: `sentry:${issue.id}`,
    url: firstHttpUrl(issue.web_url, issue.permalink),
    severity: severityFromLevel(issue.level),
    payload: {
      issueId: issue.id,
      shortId: issue.shortId ?? null,
      culprit: issue.culprit ?? null,
      project: issue.project?.slug ?? null,
      level: issue.level ?? null,
      count: wholeNumberOrNull(issue.count),
      action,
    },
  };
}

/** An issue alert rule fired for one event. */
function normaliseEventAlert(body: unknown): NormalisedSignal | null {
  const parsed = eventAlertDelivery.safeParse(body);
  if (!parsed.success) return null;
  const { event, triggered_rule: rule } = parsed.data.data;

  const fingerprint = event.issue_id
    ? `sentry:${event.issue_id}`
    : event.event_id
      ? `sentry:event:${event.event_id}`
      : null;
  if (fingerprint === null) return null;

  const parts = [rule, event.title].filter((part): part is string => Boolean(part?.trim()));
  return {
    source: 'sentry',
    kind: 'alert.triggered',
    title: parts.length > 0 ? clip(parts.join(': ')) : 'Sentry alert triggered',
    fingerprint,
    url: firstHttpUrl(event.web_url),
    severity: severityFromLevel(event.level),
    payload: {
      issueId: event.issue_id ?? null,
      eventId: event.event_id ?? null,
      rule: rule ?? null,
      culprit: event.culprit ?? null,
      level: event.level ?? null,
      action: 'triggered',
    },
  };
}

/** A metric alert crossed its critical or warning threshold. A resolution triggers nothing. */
function normaliseMetricAlert(body: unknown): NormalisedSignal | null {
  const parsed = metricAlertDelivery.safeParse(body);
  if (!parsed.success) return null;
  const { action, data } = parsed.data;
  if (action === 'resolved') return null;

  const incident = data.metric_alert;
  const ruleId = incident.alert_rule?.id ?? null;
  const identity = ruleId ?? incident.id ?? null;
  if (identity === null) return null;

  const title = data.description_title ?? incident.alert_rule?.name ?? incident.title ?? '';
  return {
    source: 'sentry',
    kind: 'alert.triggered',
    title: title.trim().length > 0 ? clip(title) : 'Sentry metric alert',
    fingerprint: `sentry:metric-alert:${identity}`,
    url: firstHttpUrl(data.web_url),
    severity: action,
    payload: {
      alertRuleId: ruleId,
      incidentId: incident.id ?? null,
      rule: incident.alert_rule?.name ?? null,
      action,
    },
  };
}

export const sentryAdapter: SignalAdapter = {
  source: 'sentry',

  verify(rawBody, headers, secret) {
    try {
      return verifyHmacSha256(rawBody, header(headers, SIGNATURE_HEADER), secret);
    } catch {
      return false;
    }
  },

  normalise(body, headers) {
    switch (header(headers, RESOURCE_HEADER)) {
      case 'issue':
        return normaliseIssue(body);
      case 'event_alert':
        return normaliseEventAlert(body);
      case 'metric_alert':
        return normaliseMetricAlert(body);
      default:
        // installation, error, comment, seer, preprod_artifact and anything new.
        return null;
    }
  },
};
