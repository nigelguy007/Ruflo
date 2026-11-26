/**
 * End-to-end check against the real, built server (not the mock).
 *
 *   npm run build && npm run e2e
 *
 * Boots dist/server/index.js on a spare port with a throwaway database, then:
 *   1. the landing page and the console load with no console errors and no
 *      request to any other origin;
 *   2. a manual signal starts a run that reaches the gate, the decision shows
 *      up in the console Inbox, a person approves it there, and the run
 *      finishes as succeeded;
 *   3. a second signal is rejected at the gate and the run ends as rejected;
 *   4. the ledger verifies.
 * Screenshots go to tests/e2e/artifacts/run/ (git-ignored).
 *
 * E2E_COORDINATION=auto exercises the Ruflo bridge; the default is local so
 * the check does not depend on npx being able to fetch ruflo.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(ROOT, 'tests', 'e2e', 'artifacts', 'run');
const PORT = Number(process.env.E2E_PORT ?? 4391);
const BASE = `http://127.0.0.1:${PORT}`;
const STEP_TIMEOUT_MS = 60_000;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`${path}: ${res.status} ${body.error?.code} ${body.error?.message}`);
  return body.data;
}

async function waitFor(what, probe, timeoutMs = STEP_TIMEOUT_MS) {
  const started = Date.now();
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function startServer(dataDir) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/server/index.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SWITCHYARD_PORT: String(PORT),
      SWITCHYARD_HOST: '127.0.0.1',
      SWITCHYARD_DB: join(dataDir, 'e2e.db'),
      SWITCHYARD_MODE: 'simulate',
      SWITCHYARD_STEP_DELAY_MS: '150',
      SWITCHYARD_COORDINATION: process.env.E2E_COORDINATION ?? 'local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}

async function runToGate(title) {
  const result = await api('/api/signals/manual', {
    method: 'POST',
    body: JSON.stringify({ title, kind: 'manual.error', severity: 'error' }),
  });
  const runId = result.runs[0]?.id;
  if (!runId) throw new Error(`signal "${title}" started no run: ${JSON.stringify(result)}`);
  await waitFor(`run ${runId} to reach the gate`, async () => {
    const detail = await api(`/api/runs/${runId}`);
    return detail.run.status === 'waiting_gate' ? detail : undefined;
  });
  return runId;
}

async function waitForStatus(runId, status) {
  return waitFor(`run ${runId} to be ${status}`, async () => {
    const detail = await api(`/api/runs/${runId}`);
    if (['failed', 'cancelled'].includes(detail.run.status) && detail.run.status !== status) {
      throw new Error(`run ended as ${detail.run.status}: ${detail.run.stopReason}`);
    }
    return detail.run.status === status ? detail : undefined;
  });
}

function watchPage(page) {
  const errors = [];
  const foreign = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) foreign.push(url);
  });
  return { errors, foreign };
}

async function checkLanding(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const seen = watchPage(page);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const h1 = await page.locator('h1').first().innerText();
  await page.screenshot({ path: join(ARTIFACTS, 'landing.png'), fullPage: true });
  record('landing page renders an h1', h1.trim().length > 0, h1.replace(/\s+/g, ' ').trim());
  record('landing page: no console errors', seen.errors.length === 0, seen.errors.join(' | '));
  record('landing page: no third-party requests', seen.foreign.length === 0, seen.foreign.join(' '));
  await page.close();
}

async function approveInConsole(browser, runId) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const seen = watchPage(page);
  // The console keeps /api/stream open on purpose, so "networkidle" never fires.
  await page.goto(`${BASE}/app/`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const approve = page.getByRole('button', { name: /^approve/i }).first();
  await approve.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.screenshot({ path: join(ARTIFACTS, 'inbox-decision.png'), fullPage: true });
  const evidence = await page.getByText(/simulated|verified by the engine|claimed by an agent/i).count();
  record('inbox shows evidence on the decision', evidence > 0, `${evidence} matching labels`);
  await approve.click();
  const detail = await waitForStatus(runId, 'succeeded');
  record('approve in the console finishes the run', detail.run.status === 'succeeded', runId);
  await page.goto(`${BASE}/app/runs/${runId}`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.screenshot({ path: join(ARTIFACTS, 'run-detail.png'), fullPage: true });
  record('console: no console errors', seen.errors.length === 0, seen.errors.join(' | '));
  record('console: no third-party requests', seen.foreign.length === 0, seen.foreign.join(' '));
  await page.close();
}

async function rejectThroughApi(runId) {
  const open = await api('/api/decisions?status=open');
  const decision = open.find((d) => d.runId === runId);
  if (!decision) throw new Error(`no open decision for ${runId}`);
  await api(`/api/decisions/${decision.id}`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'reject', note: 'e2e: reject path' }),
  });
  const detail = await waitForStatus(runId, 'rejected');
  const skipped = detail.run.steps.filter((s) => s.status === 'skipped').length;
  record('reject at the gate ends the run as rejected', detail.run.status === 'rejected', `${skipped} steps skipped`);
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'switchyard-e2e-'));
  const { child, log } = startServer(dataDir);
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  try {
    const health = await waitFor('the server to answer /api/health', () => api('/api/health'), 45_000);
    record('server boots', health.status === 'ok', `mode=${health.mode} coordination=${health.coordination}`);
    await checkLanding(browser);
    const approvedRun = await runToGate('Checkout fails when the amount is missing');
    record('signal → run reaches the gate', true, approvedRun);
    await approveInConsole(browser, approvedRun);
    const rejectedRun = await runToGate('Nightly export writes an empty file');
    await rejectThroughApi(rejectedRun);
    const ledger = await api('/api/ledger/verify');
    record('ledger verifies', ledger.ok, `${ledger.checked} entries`);
  } catch (error) {
    record('end-to-end flow', false, error instanceof Error ? error.message : String(error));
    process.stdout.write(`--- server log tail ---\n${log.join('').slice(-3000)}\n`);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    await sleep(500);
    rmSync(dataDir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
