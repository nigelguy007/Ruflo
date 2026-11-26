#!/usr/bin/env node
/**
 * Posts a manual signal to a running Switchyard server and prints the run it started.
 *
 *   node scripts/demo-signal.mjs "Checkout page throws on an empty cart"
 *
 * SWITCHYARD_URL defaults to http://127.0.0.1:4310; set SWITCHYARD_TOKEN when the server needs one.
 */

const DEFAULT_URL = 'http://127.0.0.1:4310';
const DEFAULT_TITLE = 'Checkout page throws TypeError on an empty cart';
const KIND = 'manual.error';
const TIMEOUT_MS = 10_000;

function print(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`demo-signal: ${line}\n`);
  process.exit(1);
}

function requestFor(baseUrl, token, title) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    url: new URL('/api/signals/manual', baseUrl),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, kind: KIND, severity: 'error' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  };
}

async function send(baseUrl, token, title) {
  const { url, init } = requestFor(baseUrl, token, title);
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    fail(`could not reach ${baseUrl} (${error instanceof Error ? error.message : String(error)}). Is the server running?`);
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    fail(`the server answered ${response.status} without a JSON body.`);
  }
  if (!envelope || envelope.success !== true) {
    const reason = envelope?.error ? `${envelope.error.code}: ${envelope.error.message}` : `HTTP ${response.status}`;
    fail(`the server refused the signal (${reason}).`);
  }
  return envelope.data;
}

async function main() {
  const baseUrl = process.env.SWITCHYARD_URL || DEFAULT_URL;
  const token = process.env.SWITCHYARD_TOKEN || '';
  const title = process.argv.slice(2).join(' ').trim() || DEFAULT_TITLE;
  const result = await send(baseUrl, token, title);
  for (const run of result.runs) print(run.id);
  for (const runId of result.joined) print(`${runId} (joined: the same problem is already being handled)`);
  if (result.runs.length === 0 && result.joined.length === 0) {
    fail(`signal ${result.signal?.id ?? '(ignored)'} was stored, but no watch matched kind "${KIND}".`);
  }
}

await main();
