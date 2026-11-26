/**
 * The HTTP surface, in one place.
 *
 * Every JSON response is an ApiEnvelope<T> (see types.ts).
 *
 *   GET   /api/health                 Health               no auth
 *   GET   /api/overview               Overview
 *   GET   /api/operators              Operator[]
 *   GET   /api/playbooks              Playbook[]
 *   GET   /api/watches                Watch[]
 *   PATCH /api/watches/:id            Watch                body: { enabled }
 *   GET   /api/schedules              Schedule[]
 *   GET   /api/signals?limit          Signal[]
 *   POST  /api/signals/manual         SignalResult         body: ManualSignalInput
 *   POST  /api/hooks/sentry           SignalResult         HMAC signature, no bearer
 *   POST  /api/hooks/github           SignalResult         HMAC signature, no bearer
 *   GET   /api/runs?status&limit      Run[]
 *   GET   /api/runs/:id               RunDetail
 *   POST  /api/runs/:id/cancel        Run
 *   GET   /api/decisions?status       Decision[]
 *   POST  /api/decisions/:id          Decision             body: DecisionInput
 *   GET   /api/settings               Settings
 *   PUT   /api/settings               Settings             body: { paused }
 *   GET   /api/ledger/verify          LedgerCheck
 *   GET   /api/stream                 text/event-stream of StreamEvent
 *
 * Error codes: bad_request, unauthorized, forbidden, not_found, conflict,
 * rate_limited, payload_too_large, internal.
 */
export const API = {
  health: '/api/health',
  overview: '/api/overview',
  operators: '/api/operators',
  playbooks: '/api/playbooks',
  watches: '/api/watches',
  watch: (id: string) => `/api/watches/${encodeURIComponent(id)}`,
  schedules: '/api/schedules',
  signals: '/api/signals',
  manualSignal: '/api/signals/manual',
  sentryHook: '/api/hooks/sentry',
  githubHook: '/api/hooks/github',
  runs: '/api/runs',
  run: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
  cancelRun: (id: string) => `/api/runs/${encodeURIComponent(id)}/cancel`,
  decisions: '/api/decisions',
  decision: (id: string) => `/api/decisions/${encodeURIComponent(id)}`,
  settings: '/api/settings',
  ledgerVerify: '/api/ledger/verify',
  stream: '/api/stream',
} as const;

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Request bodies larger than this are rejected before parsing. */
export const MAX_BODY_BYTES = 256 * 1024;
