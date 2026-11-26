import { z } from 'zod';
import type { NormalisedSignal, SignalAdapter } from '../ports.js';
import { verifyHmacSha256 } from './hmac.js';
import { clip, firstHttpUrl, header } from './text.js';

/**
 * GitHub repository and organisation webhooks (JSON content type).
 *
 * The signature is `sha256=<hex>` in `X-Hub-Signature-256`: the HMAC-SHA256 of
 * the raw body keyed with the webhook secret. The event name is in
 * `X-GitHub-Event`.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';
const EVENT_HEADER = 'x-github-event';
const SIGNATURE_PREFIX = 'sha256=';

const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set(['opened', 'reopened', 'ready_for_review']);
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out']);

const name = z.string().min(1).max(300);

const repository = z.object({
  name,
  full_name: name,
  default_branch: name.nullish(),
});

const sender = z.object({ login: name }).nullish();

const pullRequestDelivery = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  pull_request: z.object({
    title: z.string(),
    html_url: z.string().nullish(),
    head: z.object({ sha: name, ref: name }),
  }),
  repository,
  sender,
});

const checkRunDelivery = z.object({
  action: z.string(),
  check_run: z.object({
    name,
    head_sha: name,
    conclusion: z.string().nullish(),
    html_url: z.string().nullish(),
    details_url: z.string().nullish(),
    check_suite: z.object({ head_branch: z.string().nullish() }),
  }),
  repository,
  sender,
});

const workflowRunDelivery = z.object({
  action: z.string(),
  workflow_run: z.object({
    name,
    head_branch: z.string().nullish(),
    head_sha: name,
    conclusion: z.string().nullish(),
    html_url: z.string().nullish(),
    head_repository: z.object({ full_name: z.string().nullish() }).nullish(),
  }),
  repository,
  sender,
});

type Repository = z.infer<typeof repository>;
type Sender = z.infer<typeof sender>;

interface Subject {
  repository: Repository;
  sender: Sender;
  number: number | null;
  sha: string;
  branch: string;
}

/** The fields every GitHub signal carries, shaped so watches can match on `repository.name`. */
function basePayload(subject: Subject): Record<string, unknown> {
  return {
    repository: { name: subject.repository.name, full_name: subject.repository.full_name },
    number: subject.number,
    sha: subject.sha,
    branch: subject.branch,
    sender: { login: subject.sender?.login ?? null },
  };
}

function normalisePullRequest(body: unknown): NormalisedSignal | null {
  const parsed = pullRequestDelivery.safeParse(body);
  if (!parsed.success) return null;
  const { action, number, pull_request: pull, repository: repo, sender: who } = parsed.data;
  if (!PULL_REQUEST_ACTIONS.has(action)) return null;

  const title = clip(pull.title);
  return {
    source: 'github',
    kind: 'pull_request.opened',
    title: clip(title.length > 0 ? `PR #${number}: ${title}` : `PR #${number} in ${repo.full_name}`),
    fingerprint: `github:${repo.full_name}:pr:${number}`,
    url: firstHttpUrl(pull.html_url),
    severity: 'info',
    payload: {
      ...basePayload({ repository: repo, sender: who, number, sha: pull.head.sha, branch: pull.head.ref }),
      action,
    },
  };
}

interface FailedCheck {
  repository: Repository;
  sender: Sender;
  check: string;
  branch: string;
  sha: string;
  conclusion: string;
  url: string | null;
}

function failedCheckSignal(failed: FailedCheck): NormalisedSignal {
  const { repository: repo, check, branch } = failed;
  return {
    source: 'github',
    kind: 'check_run.failed',
    title: clip(`${check} failed on ${branch} in ${repo.full_name}`),
    fingerprint: `github:${repo.full_name}:check:${check}:${branch}`,
    url: failed.url,
    severity: 'error',
    payload: {
      ...basePayload({ repository: repo, sender: failed.sender, number: null, sha: failed.sha, branch }),
      check,
      conclusion: failed.conclusion,
    },
  };
}

function normaliseCheckRun(body: unknown): NormalisedSignal | null {
  const parsed = checkRunDelivery.safeParse(body);
  if (!parsed.success) return null;
  const { action, check_run: run, repository: repo, sender: who } = parsed.data;
  const branch = run.check_suite.head_branch;

  if (action !== 'completed' || !run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) return null;
  // GitHub reports a null head branch for runs on forks, which are never the default branch.
  if (!branch || !repo.default_branch || branch !== repo.default_branch) return null;

  return failedCheckSignal({
    repository: repo,
    sender: who,
    check: run.name,
    branch,
    sha: run.head_sha,
    conclusion: run.conclusion,
    url: firstHttpUrl(run.html_url, run.details_url),
  });
}

function normaliseWorkflowRun(body: unknown): NormalisedSignal | null {
  const parsed = workflowRunDelivery.safeParse(body);
  if (!parsed.success) return null;
  const { action, workflow_run: run, repository: repo, sender: who } = parsed.data;
  const branch = run.head_branch;

  if (action !== 'completed' || !run.conclusion || !FAILED_CONCLUSIONS.has(run.conclusion)) return null;
  if (!branch || !repo.default_branch || branch !== repo.default_branch) return null;
  // A pull request from a fork whose branch happens to share the default branch's name.
  const headRepository = run.head_repository?.full_name;
  if (headRepository && headRepository !== repo.full_name) return null;

  return failedCheckSignal({
    repository: repo,
    sender: who,
    check: run.name,
    branch,
    sha: run.head_sha,
    conclusion: run.conclusion,
    url: firstHttpUrl(run.html_url),
  });
}

export const githubAdapter: SignalAdapter = {
  source: 'github',

  verify(rawBody, headers, secret) {
    try {
      const signature = header(headers, SIGNATURE_HEADER);
      if (signature === undefined || !signature.startsWith(SIGNATURE_PREFIX)) return false;
      return verifyHmacSha256(rawBody, signature.slice(SIGNATURE_PREFIX.length), secret);
    } catch {
      return false;
    }
  },

  normalise(body, headers) {
    switch (header(headers, EVENT_HEADER)) {
      case 'pull_request':
        return normalisePullRequest(body);
      case 'check_run':
        return normaliseCheckRun(body);
      case 'workflow_run':
        return normaliseWorkflowRun(body);
      default:
        // ping, push and every event Switchyard has no playbook for.
        return null;
    }
  },
};
