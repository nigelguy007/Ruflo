// A dependency-free stand-in for the Switchyard server, for console checks.
// Serves the built dist/web (with /app/* falling back to app/index.html) and
// answers every route in src/shared/api.ts with ApiEnvelope-shaped fixtures.
// State is in memory: answering a decision, pausing, toggling a watch or
// sending a manual signal changes what later requests see.
//
//   PORT=4320 node tests/e2e/mock-api.mjs

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const WEB_ROOT = resolve(REPO, 'dist/web');
const PORT = Number(process.env.PORT ?? 4320);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;
const FIRST_EVENT_MS = 1000;
const HEARTBEAT_MS = 5000;
const T0 = Date.now();

const readJson = (path) => JSON.parse(readFileSync(resolve(REPO, path), 'utf8'));
const ago = (minutes) => new Date(T0 - minutes * 60_000).toISOString();
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;

// ── Config-backed fixtures ──────────────────────────────────────────────────

const operatorDefs = readJson('config/operators.json');
const watches = readJson('config/watches.json');
const schedules = readJson('config/schedules.json');
const playbooks = readdirSync(resolve(REPO, 'config/playbooks'))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => readJson(`config/playbooks/${file}`));
const playbookById = new Map(playbooks.map((playbook) => [playbook.id, playbook]));

const settings = { paused: false, mode: 'simulate' };

/** plan: one [status, summary, attempt] per step; steps start three minutes apart from `startMin` ago. */
function stepRuns(playbookId, plan, startMin) {
  let at = startMin;
  return playbookById.get(playbookId).steps.map((step, index) => {
    const [status = 'pending', summary = null, attempt = 1] = plan[index] ?? [];
    const started = status === 'pending' || status === 'skipped' ? null : ago(at);
    if (started) at -= 3;
    const finished = status === 'succeeded' || status === 'failed' ? ago(at) : null;
    const operator = step.kind === 'agent' ? step.operator : null;
    return { stepId: step.id, kind: step.kind, title: step.title, operator, status, attempt, startedAt: started, finishedAt: finished, summary };
  });
}

function makeRun(id, playbookId, fields) {
  const playbook = playbookById.get(playbookId);
  return {
    id, playbookId, playbookName: playbook.name, playbookVersion: playbook.version,
    stopReason: null, duplicateSignals: 0, finishedAt: null, ...fields,
  };
}

const signals = [
  { id: 'sig_gate', source: 'sentry', kind: 'issue.created', title: "TypeError: Cannot read properties of undefined (reading 'plan')", fingerprint: 'checkout-plan-undefined', url: 'https://sentry.io/organizations/example/issues/4471/', severity: 'error', payload: { project: 'shop-web', culprit: 'src/checkout/plan.ts in resolvePlan', count: 37 }, receivedAt: ago(27) },
  { id: 'sig_red', source: 'github', kind: 'check_run.failed', title: 'CI failed on main: billing.spec.ts timed out', fingerprint: 'main-billing-timeout', url: 'https://github.com/example/shop/actions/runs/9921', severity: 'error', payload: { repository: { name: 'shop' }, sha: '4be21c0', check: 'test' }, receivedAt: ago(10) },
  { id: 'sig_pr', source: 'github', kind: 'pull_request.opened', title: 'Pull request #482 opened: rate-limit the webhook endpoints', fingerprint: 'pr-482', url: 'https://github.com/example/shop/pull/482', severity: 'info', payload: { number: 482, author: 'mara' }, receivedAt: ago(141) },
  { id: 'sig_inv', source: 'sentry', kind: 'issue.created', title: 'RangeError: Invalid array length in invoice totals', fingerprint: 'invoice-zero-qty', url: 'https://sentry.io/organizations/example/issues/4402/', severity: 'warning', payload: { project: 'billing' }, receivedAt: ago(301) },
  { id: 'sig_nightly', source: 'schedule', kind: 'schedule.fired', title: 'Nightly dependency check', fingerprint: 'nightly-dependencies', url: null, severity: 'info', payload: { schedule: 'nightly-dependencies' }, receivedAt: ago(701) },
  { id: 'sig_dupe', source: 'sentry', kind: 'issue.created', title: "TypeError: Cannot read properties of undefined (reading 'plan')", fingerprint: 'checkout-plan-undefined', url: 'https://sentry.io/organizations/example/issues/4471/', severity: 'error', payload: { project: 'shop-web', count: 52 }, receivedAt: ago(12) },
  { id: 'sig_note', source: 'manual', kind: 'manual.note', title: 'Checking the hooks after the proxy change', fingerprint: 'manual-proxy-check', url: null, severity: 'info', payload: {}, receivedAt: ago(48) },
];

const runs = [
  makeRun('run_7f3a91', 'error-to-fix', {
    signalId: 'sig_gate', title: "TypeError in checkout: cannot read 'plan' of undefined", status: 'waiting_gate',
    createdAt: ago(27), startedAt: ago(26), currentStepId: 'approve', duplicateSignals: 2,
    steps: stepRuns('error-to-fix', [
      ['succeeded', 'Reproduced with a cart whose plan was removed mid-session.'],
      ['succeeded', 'Guarded the plan lookup and added cart-without-plan.spec.ts.'],
      ['succeeded', 'npm test exited 0: 412 passed, 0 failed.'],
      ['succeeded', 'One finding, not blocking: the fallback hides an upstream bug. Merge with `gh pr merge --squash` once approved.'],
      ['waiting'],
    ], 26),
  }),
  makeRun('run_c21e04', 'red-main', {
    signalId: 'sig_red', title: 'main is red: billing.spec.ts times out after the retry change', status: 'running',
    createdAt: ago(10), startedAt: ago(9), currentStepId: 'fix',
    steps: stepRuns('red-main', [
      ['succeeded', 'Introduced by 4be21c0: the retry loop never resolves while the test clock is frozen.'],
      ['running'],
    ], 9),
  }),
  makeRun('run_a90b52', 'review-pull-request', {
    signalId: 'sig_pr', title: 'Review #482: rate-limit the webhook endpoints', status: 'succeeded',
    createdAt: ago(141), startedAt: ago(140), finishedAt: ago(134), currentStepId: null,
    steps: stepRuns('review-pull-request', [['succeeded', 'npm test exited 0.'], ['succeeded', 'No findings.']], 140),
  }),
  makeRun('run_5d17e8', 'error-to-fix', {
    signalId: 'sig_inv', title: 'RangeError in invoice totals for zero-quantity lines', status: 'failed',
    createdAt: ago(301), startedAt: ago(300), finishedAt: ago(291), currentStepId: null,
    stopReason: 'The test suite exited 1 after the fix: 2 tests in invoice-totals.spec.ts still fail. The run stopped before review, as the playbook requires.',
    steps: stepRuns('error-to-fix', [
      ['succeeded', 'Zero-quantity lines produce a negative array length in splitTotals().'],
      ['succeeded', 'Clamped the line count and added a regression test.', 2],
      ['failed', '`npm test` exited with code 1; the playbook expects 0.'],
      ['skipped'], ['skipped'], ['skipped'], ['skipped'],
    ], 300),
  }),
  makeRun('run_e4402c', 'nightly-dependency-check', {
    signalId: 'sig_nightly', title: 'Nightly dependency check', status: 'rejected',
    createdAt: ago(701), startedAt: ago(700), finishedAt: ago(655), currentStepId: null,
    stopReason: 'A person rejected the merge: "Hold until the release freeze ends on Monday."',
    steps: stepRuns('nightly-dependency-check', [
      ['succeeded', '3 advisories, 2 worth an upgrade.'], ['succeeded', 'Picked undici and semver; skipped a major jump.'],
      ['succeeded', 'Opened pull request #477.'], ['succeeded', 'npm test exited 0.'],
      ['failed', 'Rejected by a person.'], ['skipped'],
    ], 700),
  }),
];

const evidence = [
  ['run_7f3a91', 'tests', 'verified', 'Test suite passed', '$ npm test\nexit code 0 (expected 0)\n412 passed, 0 failed in 38.2 s', true],
  ['run_7f3a91', 'tests', 'verified', 'Regression test fails without the fix', 'cart-without-plan.spec.ts fails on main and passes on the branch.', true],
  ['run_7f3a91', 'reproduce', 'claimed', 'Reproduced the error', 'A cart whose plan is removed mid-session triggers it on every checkout.', true],
  ['run_7f3a91', 'fix', 'claimed', 'Change is limited to src/checkout/plan.ts', 'One guard and one new test file; no public interface moved.', true],
  ['run_7f3a91', 'review', 'claimed', 'The fallback hides an upstream bug', 'Plans should never disappear from an open cart. Worth a follow-up issue before the next release.', false],
  ['run_7f3a91', 'watch', 'simulated', 'Projected error rate after deploy', 'Generated in simulate mode for the demo: 0.4% falls to 0.0%.', null],
  ['run_5d17e8', 'tests', 'verified', 'Test suite failed', '$ npm test\nexit code 1 (expected 0)\n2 failed in invoice-totals.spec.ts', false],
  ['run_c21e04', 'diagnose', 'simulated', 'Commit 4be21c0 introduced the timeout', 'Generated in simulate mode for the demo.', true],
  ['run_5d17e8', 'fix', 'claimed', 'Fix clamps the line count', 'Second attempt; the first left a negative length when every line is zero.', true],
  ['run_a90b52', 'tests', 'verified', 'Test suite passed', 'npm test exited 0.', true],
  ['run_a90b52', 'review', 'claimed', 'No findings', 'Read the diff in a fresh session; nothing unrelated moved.', null],
].map(([runId, stepId, kind, label, detail, ok], index) => ({ id: `ev_${index + 1}`, runId, stepId, kind, label, detail, ok }));

const decisions = [
  { id: 'dec_7f3a91', runId: 'run_7f3a91', runTitle: runs[0].title, stepId: 'approve', question: 'Merge this fix and deploy it to production?', status: 'open', openedAt: ago(8), decidedAt: null, decidedBy: null, note: null },
  { id: 'dec_e4402c', runId: 'run_e4402c', runTitle: runs[4].title, stepId: 'approve', question: 'Merge these dependency upgrades?', status: 'rejected', openedAt: ago(660), decidedAt: ago(655), decidedBy: 'human', note: 'Hold until the release freeze ends on Monday.' },
];

// ── The ledger: a real hash chain, so /api/ledger/verify has something to check ──

const timeline = [];
const GENESIS = '0'.repeat(64);

function entryHash(entry) {
  const { hash: _hash, ...rest } = entry;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function append(runId, actor, kind, text, at = now(), mentions = [], data = null) {
  const previous = timeline.at(-1);
  const entry = { seq: (previous?.seq ?? 0) + 1, id: newId('evt'), runId, at, actor, kind, text, mentions, data, prevHash: previous?.hash ?? GENESIS };
  entry.hash = entryHash(entry);
  timeline.push(entry);
  return entry;
}

const seedEvents = [
  ['run_e4402c', 700, 'system', 'signal', 'The nightly schedule fired.'],
  ['run_e4402c', 699, 'system', 'system', 'Started Nightly dependency check v1.'],
  ['run_e4402c', 690, 'inspector', 'handoff', 'Two upgrades are worth doing. Over to @fitter.', ['fitter'], { from: 'inspector', to: 'fitter' }],
  ['run_e4402c', 660, 'system', 'gate_opened', 'Waiting for a person: Merge these dependency upgrades?'],
  ['run_e4402c', 655, 'human', 'gate_resolved', 'Rejected: Hold until the release freeze ends on Monday.'],
  ['run_5d17e8', 300, 'system', 'signal', 'Sentry reported a new issue in billing.'],
  ['run_5d17e8', 297, 'inspector', 'note', 'Zero-quantity lines produce a negative array length. Handing the case to @fitter.', ['fitter']],
  ['run_5d17e8', 296, 'inspector', 'handoff', 'Reproduction handed over.', ['fitter'], { from: 'inspector', to: 'fitter' }],
  ['run_5d17e8', 293, 'fitter', 'artifact', 'Pushed the second attempt.', [], { artifact: { kind: 'diff', label: 'Diff', value: 'fix/invoice-zero-qty @ 9c1f3aa' } }],
  ['run_5d17e8', 292, 'system', 'command', '`npm test` exited with code 1; the playbook expects 0.', [], { exitCode: 1 }],
  ['run_5d17e8', 291, 'system', 'error', 'Stopped: the test suite failed after the fix, so review did not start.'],
  ['run_a90b52', 140, 'system', 'signal', 'GitHub reported pull request #482.'],
  ['run_a90b52', 137, 'system', 'command', 'npm test exited 0.', [], { exitCode: 0 }],
  ['run_a90b52', 134, 'checker', 'note', 'No findings. Nothing unrelated moved.'],
  ['run_7f3a91', 26, 'system', 'signal', 'Sentry reported a new issue: TypeError in checkout.'],
  ['run_7f3a91', 25, 'system', 'system', 'Started Production error to shipped fix v1.'],
  ['run_7f3a91', 22, 'inspector', 'note', 'Reproduced with a cart whose plan was removed mid-session. @fitter, the failing case is attached.', ['fitter']],
  ['run_7f3a91', 22, 'inspector', 'handoff', 'Reproduction and likely cause handed over.', ['fitter'], { from: 'inspector', to: 'fitter' }],
  ['run_7f3a91', 17, 'fitter', 'artifact', 'Opened a pull request with the fix and a regression test.', [], { artifact: { kind: 'pr', label: 'Pull request #483', value: 'https://github.com/example/shop/pull/483' } }],
  ['run_7f3a91', 15, 'system', 'command', 'Ran `npm test`: exit code 0 (expected 0).', [], { exitCode: 0 }],
  ['run_7f3a91', 14, 'fitter', 'handoff', 'Ready for an independent review.', ['checker'], { from: 'fitter', to: 'checker' }],
  ['run_7f3a91', 9, 'checker', 'note', 'One finding, not blocking: the fallback hides an upstream bug. @dispatcher should watch the checkout error rate after deploy.', ['dispatcher']],
  ['run_7f3a91', 8, 'system', 'gate_opened', 'Waiting for a person: Merge this fix and deploy it to production?'],
  ['run_c21e04', 9, 'system', 'signal', 'GitHub reported a failed check on main.'],
  ['run_c21e04', 6, 'inspector', 'handoff', 'Commit 4be21c0 broke it. Over to @fitter.', ['fitter'], { from: 'inspector', to: 'fitter' }],
];
for (const [runId, minutes, actor, kind, text, mentions, data] of seedEvents) append(runId, actor, kind, text, ago(minutes), mentions, data);

// ── Derived views ───────────────────────────────────────────────────────────

const isActive = (run) => ['queued', 'running', 'waiting_gate'].includes(run.status);
const ACTIVITY = { run_c21e04: 'Writing the fix for the frozen-clock retry loop' };

function operators() {
  const view = new Map(operatorDefs.map((def) => [def.id, { ...def, status: settings.paused ? 'paused' : 'idle', currentRunId: null, currentActivity: null }]));
  for (const run of runs.filter(isActive)) {
    const steps = playbookById.get(run.playbookId).steps;
    const index = steps.findIndex((step) => step.id === run.currentStepId);
    const step = steps[index];
    if (!step) continue;
    if (step.kind === 'agent' && run.status === 'running') {
      Object.assign(view.get(step.operator), { status: 'working', currentRunId: run.id, currentActivity: ACTIVITY[run.id] ?? step.title });
    } else if (step.kind === 'gate') {
      const before = steps.slice(0, index).reverse().find((candidate) => candidate.kind === 'agent');
      const who = before?.handoffTo ?? before?.operator;
      if (who) Object.assign(view.get(who), { status: 'waiting', currentRunId: run.id, currentActivity: `Waiting for a person to answer: ${step.question}` });
    }
  }
  return [...view.values()];
}

const decisionView = (decision) => ({ ...decision, evidence: evidence.filter((item) => item.runId === decision.runId) });

function overview() {
  return {
    operators: operators(),
    openDecisions: decisions.filter((decision) => decision.status === 'open').length,
    activeRuns: runs.filter(isActive).length,
    failedRuns: runs.filter((run) => run.status === 'failed').length,
    lastSignalAt: signals.map((signal) => signal.receivedAt).sort().at(-1) ?? null,
    digest: { since: ago(24 * 60), handledWithoutYou: 6, decisionsMade: 3, succeeded: 7, failed: 1, rejected: 1, cancelled: 0 },
  };
}

function verifyLedger() {
  let prevHash = GENESIS;
  for (const entry of timeline) {
    if (entry.prevHash !== prevHash || entry.hash !== entryHash(entry)) return { ok: false, checked: timeline.length, brokenAt: entry.seq };
    prevHash = entry.hash;
  }
  return { ok: true, checked: timeline.length, brokenAt: null };
}

// ── The live stream ─────────────────────────────────────────────────────────

const streams = new Set();

function broadcast(type, key, value) {
  const frame = `event: ${type}\ndata: ${JSON.stringify({ type, [key]: value })}\n\n`;
  for (const res of streams) res.write(frame);
}

function openStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  streams.add(res);
  const first = setTimeout(() => {
    const running = runs.find((run) => run.id === 'run_c21e04');
    res.write(`event: run.updated\ndata: ${JSON.stringify({ type: 'run.updated', run: running })}\n\n`);
  }, FIRST_EVENT_MS);
  const beat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearTimeout(first);
    clearInterval(beat);
    streams.delete(res);
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, 'bad_request', message);
const notFound = (what) => new HttpError(404, 'not_found', `There is no ${what} with that id.`);

function resolveDecision(id, body) {
  const decision = decisions.find((item) => item.id === id);
  if (!decision) throw notFound('decision');
  if (body.verdict !== 'approve' && body.verdict !== 'reject') throw badRequest('verdict must be "approve" or "reject".');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) throw badRequest('note must be a string of at most 2000 characters.');
  if (decision.status !== 'open') throw new HttpError(409, 'conflict', 'This decision was already answered.');
  const approved = body.verdict === 'approve';
  Object.assign(decision, { status: approved ? 'approved' : 'rejected', decidedAt: now(), decidedBy: 'human', note: body.note ?? null });
  const run = runs.find((item) => item.id === decision.runId);
  const gate = run.steps.find((step) => step.stepId === decision.stepId);
  Object.assign(gate, { status: approved ? 'succeeded' : 'failed', finishedAt: now(), summary: approved ? 'Approved by a person.' : 'Rejected by a person.' });
  const next = run.steps[run.steps.indexOf(gate) + 1];
  if (approved && next) {
    Object.assign(next, { status: 'running', startedAt: now() });
    Object.assign(run, { status: 'running', currentStepId: next.stepId });
  } else {
    for (const step of run.steps.filter((item) => item.status === 'pending')) step.status = 'skipped';
    Object.assign(run, { status: approved ? 'succeeded' : 'rejected', currentStepId: null, finishedAt: now(), stopReason: approved ? null : `A person rejected: ${body.note || 'no reason given'}` });
  }
  const entry = append(run.id, 'human', 'gate_resolved', `${approved ? 'Approved' : 'Rejected'}${body.note ? `: ${body.note}` : '.'}`);
  broadcast('timeline.appended', 'event', entry);
  broadcast('decision.resolved', 'decision', decisionView(decision));
  broadcast('run.updated', 'run', run);
  return decisionView(decision);
}

const SEVERITIES = ['info', 'warning', 'error', 'critical'];

function manualSignal(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) throw badRequest('title is required and must be at most 200 characters.');
  const kind = body.kind ?? 'manual.run';
  if (typeof kind !== 'string' || !/^[a-z0-9_.-]{1,80}$/.test(kind)) throw badRequest('kind must be lowercase letters, digits, dots, dashes or underscores.');
  const severity = body.severity ?? 'info';
  if (!SEVERITIES.includes(severity)) throw badRequest(`severity must be one of ${SEVERITIES.join(', ')}.`);
  if (body.playbookId !== undefined && !playbookById.has(body.playbookId)) throw badRequest('playbookId does not name a playbook.');
  const signal = { id: newId('sig'), source: 'manual', kind, title, fingerprint: body.fingerprint ?? `manual-${randomBytes(3).toString('hex')}`, url: typeof body.url === 'string' ? body.url : null, severity, payload: body.payload ?? {}, receivedAt: now() };
  signals.unshift(signal);
  broadcast('signal.received', 'signal', signal);
  const watch = watches.find((item) => item.enabled && item.source === 'manual' && (item.kinds.length === 0 || item.kinds.includes(kind)));
  const playbookId = body.playbookId ?? watch?.playbookId;
  if (!playbookId) return { signal, runs: [], joined: [] };
  const steps = stepRuns(playbookId, [], 0);
  Object.assign(steps[0], { status: 'running', startedAt: now() });
  const run = makeRun(newId('run'), playbookId, { signalId: signal.id, title, status: 'running', createdAt: now(), startedAt: now(), currentStepId: steps[0].stepId, steps });
  runs.unshift(run);
  append(run.id, 'system', 'signal', `A manual signal arrived: ${title}`);
  broadcast('run.updated', 'run', run);
  return { signal, runs: [run], joined: [] };
}

function cancelRun(id) {
  const run = runs.find((item) => item.id === id);
  if (!run) throw notFound('run');
  if (!isActive(run)) throw new HttpError(409, 'conflict', 'This run has already finished.');
  for (const step of run.steps) if (['pending', 'running', 'waiting'].includes(step.status)) step.status = 'skipped';
  Object.assign(run, { status: 'cancelled', currentStepId: null, finishedAt: now(), stopReason: 'Cancelled by a person.' });
  broadcast('run.updated', 'run', run);
  return run;
}

// ── Routing ─────────────────────────────────────────────────────────────────

function limitOf(query, fallback) {
  const value = Number(query.get('limit') ?? fallback);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 500) : fallback;
}

const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt);
const findRun = (id) => runs.find((run) => run.id === id) ?? null;

const ROUTES = [
  ['GET', /^\/api\/health$/, () => ({ status: 'ok', version: '0.1.0-mock', mode: settings.mode, paused: settings.paused, coordination: 'local' })],
  ['GET', /^\/api\/overview$/, () => overview()],
  ['GET', /^\/api\/operators$/, () => operators()],
  ['GET', /^\/api\/playbooks$/, () => playbooks],
  ['GET', /^\/api\/watches$/, () => watches],
  ['PATCH', /^\/api\/watches\/([^/]+)$/, ({ params, body }) => {
    const watch = watches.find((item) => item.id === params[0]);
    if (!watch) throw notFound('watch');
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be true or false.');
    watch.enabled = body.enabled;
    return watch;
  }],
  ['GET', /^\/api\/schedules$/, () => schedules],
  ['GET', /^\/api\/signals$/, ({ query }) => signals.slice(0, limitOf(query, 50))],
  ['POST', /^\/api\/signals\/manual$/, ({ body }) => manualSignal(body)],
  ['POST', /^\/api\/hooks\/(sentry|github)$/, () => ({ signal: null, runs: [], joined: [] })],
  ['GET', /^\/api\/runs$/, ({ query }) => {
    const status = query.get('status');
    return runs.filter((run) => !status || run.status === status).sort(byNewest).slice(0, limitOf(query, 50));
  }],
  ['GET', /^\/api\/runs\/([^/]+)$/, ({ params }) => {
    const run = findRun(params[0]);
    if (!run) throw notFound('run');
    const decision = decisions.filter((item) => item.runId === run.id).at(-1);
    return {
      run,
      signal: signals.find((signal) => signal.id === run.signalId),
      timeline: timeline.filter((entry) => entry.runId === run.id),
      evidence: evidence.filter((item) => item.runId === run.id),
      decision: decision ? decisionView(decision) : null,
    };
  }],
  ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, ({ params }) => cancelRun(params[0])],
  ['GET', /^\/api\/decisions$/, ({ query }) => {
    const status = query.get('status');
    return decisions.filter((decision) => !status || decision.status === status).map(decisionView);
  }],
  ['POST', /^\/api\/decisions\/([^/]+)$/, ({ params, body }) => resolveDecision(params[0], body)],
  ['GET', /^\/api\/settings$/, () => settings],
  ['PUT', /^\/api\/settings$/, ({ body }) => {
    if (typeof body.paused !== 'boolean') throw badRequest('paused must be true or false.');
    settings.paused = body.paused;
    broadcast('settings.updated', 'settings', settings);
    return settings;
  }],
  ['GET', /^\/api\/ledger\/verify$/, () => verifyLedger()],
];

function send(res, status, envelope) {
  const text = JSON.stringify(envelope);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload_too_large', 'The request body is too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolveBody({});
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        resolveBody(parsed);
      } catch {
        reject(badRequest('The request body is not a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/stream') return openStream(req, res);
  const candidates = ROUTES.filter(([, pattern]) => pattern.test(url.pathname));
  const route = candidates.find(([method]) => method === req.method);
  try {
    if (!route) {
      throw candidates.length > 0 ? new HttpError(405, 'bad_request', `${req.method} is not allowed here.`) : new HttpError(404, 'not_found', 'No such route.');
    }
    const params = route[1].exec(url.pathname).slice(1).map(decodeURIComponent);
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const data = route[2]({ params, query: url.searchParams, body });
    send(res, 200, { success: true, data, error: null });
  } catch (error) {
    const known = error instanceof HttpError;
    send(res, known ? error.status : 500, { success: false, data: null, error: { code: known ? error.code : 'internal', message: known ? error.message : 'The mock failed.' } });
  }
}

// ── Static files ────────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

function fileFor(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(WEB_ROOT, decoded));
  if (candidate !== WEB_ROOT && !candidate.startsWith(WEB_ROOT + sep)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  const index = join(candidate, 'index.html');
  return existsSync(index) ? index : null;
}

function serveStatic(req, res, url) {
  const inApp = url.pathname === '/app' || url.pathname.startsWith('/app/');
  const file = fileFor(url.pathname) ?? (inApp ? fileFor('/app/index.html') : null);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(existsSync(WEB_ROOT) ? 'Not found.' : 'dist/web is missing: build the web app first.');
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const cache = type.startsWith('text/html') ? 'no-store' : 'public, max-age=300';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => process.stdout.write(`mock-api listening on http://${HOST}:${PORT}\n`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const res of streams) res.end();
    server.close(() => process.exit(0));
  });
}
