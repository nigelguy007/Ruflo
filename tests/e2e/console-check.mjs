// Visual and behavioural check of the console against the mock API.
//
//   npx vite build            (or any build that produces dist/web/app/index.html)
//   node tests/e2e/console-check.mjs
//
// Screenshots every screen at 375, 768 and 1440 px in both themes into
// tests/e2e/artifacts/console/, checks for horizontal overflow (also at
// 320 px), console errors, failed requests, text contrast and, at 375 px,
// touch-target size; then answers the open decision and checks the card
// leaves the Inbox. Exits non-zero when any check fails.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');

const REPO = resolve(import.meta.dirname, '../..');
const OUT = resolve(import.meta.dirname, 'artifacts/console');
const PORT = Number(process.env.PORT ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const THEMES = ['dark', 'light'];
const PAGES = [
  { name: 'inbox', path: '/app/', ready: '.decision' },
  { name: 'floor', path: '/app/floor', ready: '.road' },
  { name: 'runs', path: '/app/runs', ready: '.run-row' },
  { name: 'run', path: '/app/runs/run_7f3a91', ready: '.track__step' },
  { name: 'run-failed', path: '/app/runs/run_5d17e8', ready: '.track__step' },
  { name: 'signals', path: '/app/signals', ready: '.signal-row' },
  { name: 'playbooks', path: '/app/playbooks', ready: '.playbook' },
  { name: 'settings', path: '/app/settings', ready: '.pause' },
];
const READY_TIMEOUT_MS = 10_000;
const SETTLE_MS = 200;

const failures = [];
const notes = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const say = (text) => process.stdout.write(`${text}\n`);

// ── In-page audits (serialised into the page, so they must be self-contained) ──

function auditOverflow() {
  const describe = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
  const width = document.documentElement.clientWidth;
  const scroll = document.documentElement.scrollWidth;
  const offenders = [];
  if (scroll > width) {
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.right > width + 0.5) offenders.push(`${describe(el)} right=${Math.round(box.right)}`);
      if (offenders.length >= 6) break;
    }
  }
  return { width, scroll, offenders };
}

function auditContrast() {
  const parse = (value) => {
    let match = value.match(/^rgba?\(([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    match = value.match(/^color\(srgb ([^)]+)\)$/);
    if (match) {
      const parts = match[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts[3] ?? 1];
    }
    return null;
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]));
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color[3] > 0) layers.push(color);
      if (color && color[3] >= 1) break;
    }
    return layers.reverse().reduce((base, layer) => over(layer, base), [255, 255, 255]);
  };
  const visible = (el) => {
    let opacity = 1;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      opacity *= Number(style.opacity);
    }
    const box = el.getBoundingClientRect();
    return opacity >= 0.99 && box.width > 1 && box.height > 1;
  };
  const results = [];
  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (!hasText || el.closest('.visually-hidden, svg, :disabled, [aria-disabled="true"]') || !visible(el)) continue;
    const style = getComputedStyle(el);
    const fg = parse(style.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const text = over(fg, bg);
    const [hi, lo] = [luminance(text), luminance(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const needed = large ? 3 : 4.5;
    if (ratio < needed) {
      const name = `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`;
      results.push(`${name} "${el.textContent.trim().slice(0, 32)}" ${ratio.toFixed(2)} < ${needed}`);
    }
  }
  return [...new Set(results)].slice(0, 12);
}

function auditTargets() {
  const MIN = 44;
  const results = [];
  const selector = 'a, button, select, textarea, input:not([type="radio"]):not([type="checkbox"]), summary, [role="switch"], .segmented__option';
  for (const el of document.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || el.closest('.visually-hidden, [hidden], dialog:not([open])')) continue;
    // A stretched link (an absolutely positioned ::after) is as big as its positioned ancestor.
    const after = getComputedStyle(el, '::after');
    const stretched = after.content !== 'none' && after.position === 'absolute' && el.offsetParent;
    const box = (stretched ? el.offsetParent : el).getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    // Links inside a sentence are exempt: the sentence is the target's spacing.
    if (el.tagName === 'A' && style.display === 'inline') {
      const parent = el.parentElement;
      const inSentence = parent && [...parent.childNodes].some((node) => node !== el && node.nodeType === 3 && node.textContent.trim());
      if (inSentence) continue;
    }
    if (box.height < MIN - 0.5 || box.width < MIN - 0.5) {
      const name = `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`;
      results.push(`${name} "${(el.textContent ?? '').trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  return [...new Set(results)].slice(0, 12);
}

// ── Harness ─────────────────────────────────────────────────────────────────

async function startMock() {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'mock-api.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill();
  throw new Error(`The mock API did not start on port ${PORT}.`);
}

function watchPage(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') fail(label(), `console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => fail(label(), `page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? 'failed';
    // The event stream is torn down on every navigation; that is expected.
    if (!request.url().endsWith('/api/stream') && !reason.includes('ERR_ABORTED')) fail(label(), `request failed: ${request.url()} (${reason})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) fail(label(), `HTTP ${response.status()} for ${response.url()}`);
  });
}

async function open(page, target) {
  await page.goto(`${BASE}${target.path}`, { waitUntil: 'load' });
  await page.waitForSelector(target.ready, { timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelectorAll('.state--loading').length === 0, null, { timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(SETTLE_MS);
}

async function audit(page, where, { width, contrast, targets }) {
  const overflow = await page.evaluate(auditOverflow);
  if (overflow.scroll > overflow.width) fail(where, `horizontal overflow ${overflow.scroll} > ${overflow.width}: ${overflow.offenders.join(', ')}`);
  if (contrast) for (const problem of await page.evaluate(auditContrast)) fail(where, `contrast ${problem}`);
  if (targets) for (const problem of await page.evaluate(auditTargets)) fail(where, `touch target ${problem}`);
  return width;
}

async function newPage(browser, viewport, theme, label, reducedMotion = 'reduce') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme, reducedMotion });
  const page = await context.newPage();
  watchPage(page, label);
  return { context, page };
}

async function selfTest(browser) {
  const { context, page } = await newPage(browser, { width: 800, height: 600 }, 'dark', () => 'self-test');
  await open(page, PAGES[2]);
  await page.evaluate(() => {
    const canary = document.createElement('p');
    canary.id = 'contrast-canary';
    canary.textContent = 'contrast canary';
    canary.style.cssText = 'color:#7a7a7a;background:#8a8a8a;font-size:14px';
    document.body.append(canary);
  });
  const caught = (await page.evaluate(auditContrast)).some((line) => line.includes('contrast canary'));
  await page.evaluate(() => document.getElementById('contrast-canary')?.remove());
  if (!caught) fail('self-test', 'the contrast audit missed a planted 1.3:1 text');
  else notes.push('contrast audit self-test: a planted 1.3:1 text was caught');
  await context.close();
}

/** Pauses from Settings, captures the barrier banner and the thrown lever, then resumes from the banner. */
async function pauseFlow(browser) {
  for (const [theme, viewport] of [['dark', { width: 1440, height: 900 }], ['light', { width: 375, height: 812 }]]) {
    const where = `pause ${viewport.width} ${theme}`;
    const { context, page } = await newPage(browser, viewport, theme, () => where);
    try {
      await open(page, PAGES.at(-1));
      await page.getByRole('switch', { name: 'Pause everything' }).click();
      await page.waitForSelector('.banner--paused', { timeout: 5000 });
      await page.waitForSelector('.pause[data-paused="true"]', { timeout: 5000 });
      await audit(page, where, { width: viewport.width, contrast: true, targets: viewport.width === 375 });
      await page.screenshot({ path: resolve(OUT, `settings-paused-${viewport.width}-${theme}.png`) });
      await page.locator('.banner--paused').getByRole('button', { name: 'Resume' }).click();
      await page.waitForFunction(() => !document.querySelector('.banner--paused'), null, { timeout: 5000 });
      notes.push(`${where}: paused from Settings, banner shown, resumed from the banner`);
    } catch (error) {
      fail(where, error.message.split('\n')[0]);
    }
    await context.close();
  }
}

async function screenshotAll(browser, pages, suffix = '') {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      let current = '';
      const { context, page } = await newPage(browser, viewport, theme, () => current);
      for (const target of pages) {
        current = `${target.name}${suffix} ${viewport.width} ${theme}`;
        try {
          await open(page, target);
          await audit(page, current, { width: viewport.width, contrast: true, targets: viewport.width === 375 });
          await page.screenshot({ path: resolve(OUT, `${target.name}${suffix}-${viewport.width}-${theme}.png`), fullPage: true });
          if (viewport.width === 375) await page.screenshot({ path: resolve(OUT, `${target.name}${suffix}-${viewport.width}-${theme}-fold.png`) });
        } catch (error) {
          fail(current, error.message.split('\n')[0]);
        }
      }
      await context.close();
    }
  }
}

async function overflowAt320(browser) {
  for (const theme of THEMES) {
    let current = '';
    const { context, page } = await newPage(browser, { width: 320, height: 640 }, theme, () => current);
    for (const target of PAGES) {
      current = `${target.name} 320 ${theme}`;
      try {
        await open(page, target);
        await audit(page, current, { width: 320, contrast: false, targets: true });
      } catch (error) {
        fail(current, error.message.split('\n')[0]);
      }
    }
    await context.close();
  }
}

async function focusRing(browser) {
  const where = 'focus 1440 dark';
  const { context, page } = await newPage(browser, { width: 1440, height: 900 }, 'dark', () => where);
  await open(page, PAGES[0]);
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab');
    const onApprove = await page.evaluate(() => document.activeElement?.classList.contains('points__approve') ?? false);
    if (onApprove) {
      const box = await page.locator('.decision__answer').boundingBox();
      if (box) await page.screenshot({ path: resolve(OUT, 'focus-approve-1440-dark.png'), clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } });
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      if (outline === 'none') fail(where, 'the focused Approve button shows no outline');
      notes.push(`keyboard reached Approve after ${press + 1} Tab presses`);
      break;
    }
    if (press === 39) fail(where, 'Tab never reached the Approve button');
  }
  await context.close();
}

async function approveFlow(browser) {
  const where = 'approve 1440 dark';
  const { context, page } = await newPage(browser, { width: 1440, height: 900 }, 'dark', () => where, 'no-preference');
  await open(page, PAGES[0]);
  const before = await page.locator('.decision').count();
  await page.locator('.decision textarea').fill('Ship it; watch checkout for an hour.');
  await page.locator('.decision').getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.decision').length === 0, null, { timeout: 5000 });
  await page.waitForSelector('.receipt[data-state="done"]', { timeout: 5000 });
  await page.waitForSelector('.clear-board', { timeout: 5000 });
  const focused = await page
    .waitForFunction(() => document.activeElement?.classList.contains('receipts'), null, { timeout: 2000 })
    .then(() => true, () => false);
  if (!focused) fail(where, 'focus did not move to the receipt after the card left');
  const announced = await page.locator('[data-testid="live-region"]').textContent();
  if (!announced?.includes('Approved')) fail(where, `live region did not announce the answer (got "${announced}")`);
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: resolve(OUT, 'inbox-approved-1440-dark.png'), fullPage: true });
  const remaining = await (await fetch(`${BASE}/api/decisions?status=open`)).json();
  if (remaining.data.length !== 0) fail(where, 'the mock still has an open decision');
  notes.push(`approve: ${before} card(s) before, 0 after; receipt shown; focus on receipt: ${focused}`);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(REPO, 'dist/web/app/index.html'))) {
    process.stderr.write('dist/web/app/index.html is missing. Build the web app first (npx vite build).\n');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const mock = await startMock();
  const browser = await chromium.launch();
  try {
    await selfTest(browser);
    await screenshotAll(browser, PAGES);
    await overflowAt320(browser);
    await focusRing(browser);
    await pauseFlow(browser);
    await approveFlow(browser);
    await screenshotAll(browser, [{ name: 'inbox', path: '/app/', ready: '.clear-board' }], '-clear');
  } finally {
    await browser.close();
    mock.kill();
  }
  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify({ failures, notes }, null, 2));
  for (const note of notes) say(`note  ${note}`);
  for (const problem of failures) say(`FAIL  ${problem}`);
  say(failures.length === 0 ? `console-check: all checks passed. Screenshots in ${OUT}` : `console-check: ${failures.length} problem(s).`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
