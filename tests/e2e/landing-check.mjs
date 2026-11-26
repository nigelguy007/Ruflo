/*
 * Landing page check.
 *
 * Builds the landing page on its own (Vite API, no config file, so the console
 * does not need to build), serves it from a tiny static server and drives it
 * with the pre-installed Playwright. Screenshots land in
 * tests/e2e/artifacts/landing/ (git-ignored).
 *
 *   node tests/e2e/landing-check.mjs
 *   LANDING_DIST=dist/web node tests/e2e/landing-check.mjs   # check an existing build
 */
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = resolve(HERE, 'artifacts/landing');
const SITE = process.env.LANDING_DIST ? resolve(REPO, process.env.LANDING_DIST) : resolve(OUT, 'site');

const SHOT_WIDTHS = [320, 375, 768, 1024, 1440, 1920];
const EXTRA_WIDTHS = [360, 414, 600, 860, 900, 960, 1100, 1280];
const THEMES = ['dark', 'light'];
const MIN_STEP = 1.25;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
};

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

async function buildLanding() {
  if (process.env.LANDING_DIST) return;
  const { build } = await import('vite');
  await build({
    root: resolve(REPO, 'src/web'),
    configFile: false,
    logLevel: 'warn',
    build: { outDir: SITE, emptyOutDir: true },
  });
}

async function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
    let file = normalize(join(SITE, path));
    if (!file.startsWith(SITE)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function open(browser, origin, { width, theme, reducedMotion = 'no-preference' }) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion,
  });
  const page = await context.newPage();
  const errors = [];
  const foreign = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol !== 'data:' && url.origin !== origin) foreign.push(req.url());
  });
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, foreign };
}

function overflowProbe() {
  const vw = document.documentElement.clientWidth;
  const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const offenders =
    sw > vw
      ? [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > vw + 0.5)
          .slice(0, 6)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')}`)
      : [];
  return { vw, sw, offenders };
}

/* Every element with its own visible text, against the colour actually behind it. */
function contrastProbe() {
  const parse = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
    return [Number(r), Number(g), Number(b), Number(a)];
  };
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) break;
      }
    }
    let colour = [255, 255, 255, 1];
    for (const layer of layers.reverse()) colour = over(layer, colour);
    return colour;
  };
  const low = [];
  let checked = 0;
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || el.closest('.vh, svg') || !el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const bg = backdrop(el);
    const fg = over(parse(style.color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    checked += 1;
    if (ratio < (large ? 3 : 4.5)) low.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
  }
  return { checked, low };
}

function typeProbe() {
  const size = (el) => parseFloat(getComputedStyle(el).fontSize);
  const all = (sel) => [...document.querySelectorAll(sel)].map(size);
  return {
    h1: size(document.querySelector('h1')),
    h2: Math.min(...all('h2')),
    h3: Math.max(...all('h3')),
    body: size(document.querySelector('.chores p')),
    lede: Math.max(...all('.lede')),
    gateQ: size(document.querySelector('.gate-q')),
    budget: size(document.querySelector('.budget dd')),
  };
}

function layoutShiftProbe() {
  return new Promise((done) => {
    let total = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) total += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => done(total), 2500);
  });
}

async function checkStructure(page) {
  const facts = await page.evaluate(() => ({
    h1: document.querySelectorAll('h1').length,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content ?? '',
    og: ['og:type', 'og:title', 'og:description', 'og:site_name'].filter(
      (p) => !document.querySelector(`meta[property="${p}"]`)?.content,
    ),
    themeColor: document.querySelectorAll('meta[name="theme-color"]').length,
    banner: Boolean(document.querySelector('body > header')),
    nav: Boolean(document.querySelector('header nav')),
    main: Boolean(document.querySelector('main#main')),
    footer: Boolean(document.querySelector('body > footer')),
    skip: document.querySelector('body > a.skip')?.getAttribute('href') ?? '',
  }));
  if (facts.h1 !== 1) fail(`expected one h1, found ${facts.h1}`);
  if (!facts.title) fail('missing <title>');
  if (!facts.description) fail('missing meta description');
  if (facts.og.length) fail(`missing Open Graph tags: ${facts.og.join(', ')}`);
  if (!facts.themeColor) fail('missing theme-color');
  if (!facts.banner || !facts.nav || !facts.main || !facts.footer) fail('missing a landmark');
  if (facts.skip !== '#main') fail('skip link does not point at #main');

  await page.keyboard.press('Tab');
  const skip = await page.evaluate(() => {
    const el = document.activeElement;
    const box = el.getBoundingClientRect();
    return { cls: el.className, top: box.top, outline: getComputedStyle(el).outlineStyle };
  });
  if (skip.cls !== 'skip' || skip.top < 0) fail('first Tab does not reveal the skip link');
  for (let i = 0; i < 2; i += 1) await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el.tagName, outline: getComputedStyle(el).outlineStyle };
  });
  if (focused.outline === 'none') fail(`keyboard focus on ${focused.tag} has no visible outline`);
}

async function checkDemo(page, label) {
  const run = page.locator('[data-run]');
  const approve = run.locator('button[data-verdict="approved"]');
  const reject = run.locator('button[data-verdict="rejected"]');
  const read = () =>
    page.evaluate(() => {
      const fig = document.querySelector('[data-run]');
      return {
        state: fig.querySelector('[data-run-state]').textContent,
        lamp: fig.querySelector('[data-run-lamp]').dataset.state,
        says: fig.querySelector('[data-run-says]').textContent,
        pressed: [...fig.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed')).join(','),
        shown: getComputedStyle(fig.querySelector('[data-run-state]')).opacity,
        height: fig.getBoundingClientRect().height,
        next: document.querySelector('#problem').getBoundingClientRect().top + window.scrollY,
      };
    });
  if (await approve.isDisabled()) fail(`${label}: Approve is still disabled after the script ran`);
  const start = await read();
  const expect = (got, want, step) => {
    for (const [key, value] of Object.entries(want)) {
      const ok = key === 'says' ? got.says.startsWith(value) : got[key] === value;
      if (!ok) fail(`${label}: after ${step}, ${key} is "${got[key]}", expected "${value}"`);
    }
    if (Math.abs(got.height - start.height) > 0.5 || Math.abs(got.next - start.next) > 0.5) {
      fail(`${label}: layout moved after ${step} (${start.height} to ${got.height})`);
    }
  };
  await approve.click();
  expect(await read(), { state: 'Approved', lamp: 'clear', says: 'Approved.', pressed: 'true,false', shown: '1' }, 'Approve');
  await reject.click();
  expect(await read(), { state: 'Rejected', lamp: 'stop', says: 'Rejected.', pressed: 'false,true', shown: '1' }, 'Reject');
  await reject.click();
  expect(await read(), { state: start.state, lamp: 'caution', says: start.says, pressed: 'false,false' }, 'Reject again');
}

async function checkToggle(page, theme, label) {
  const toggle = page.locator('#theme-toggle');
  if (!(await toggle.isVisible())) {
    fail(`${label}: theme toggle is not visible`);
    return;
  }
  const other = theme === 'dark' ? 'light' : 'dark';
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();
  if ((await toggle.getAttribute('aria-label')) !== `Switch to ${other} theme`) fail(`${label}: wrong toggle label`);
  await toggle.click();
  const set = await page.evaluate(() => document.documentElement.dataset.theme);
  if (set !== other) fail(`${label}: toggle set data-theme="${set}", expected ${other}`);
  if ((await bg()) === before) fail(`${label}: background did not change with the theme`);
  if ((await toggle.getAttribute('aria-label')) !== `Switch to ${theme} theme`) fail(`${label}: label not updated`);
  await page.screenshot({ path: `${OUT}/landing-${theme}-toggled-${other}.png`, fullPage: true, animations: 'disabled' });
  await page.reload({ waitUntil: 'load' });
  const kept = await page.evaluate(() => document.documentElement.dataset.theme);
  if (kept !== other) fail(`${label}: chosen theme not kept after reload (${kept})`);
  await page.locator('#theme-toggle').click();
  if ((await bg()) !== before) fail(`${label}: second click did not restore the theme`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await buildLanding();
  const { server, origin } = await serve();
  const browser = await chromium.launch();
  try {
    for (const theme of THEMES) {
      for (const width of [...SHOT_WIDTHS, ...EXTRA_WIDTHS]) {
        const label = `${theme} ${width}px`;
        const { context, page, errors, foreign } = await open(browser, origin, { width, theme });
        const flow = await page.evaluate(overflowProbe);
        if (flow.sw > flow.vw) fail(`${label}: horizontal overflow ${flow.sw} > ${flow.vw} (${flow.offenders.join(' ')})`);
        if (SHOT_WIDTHS.includes(width)) {
          await page.screenshot({ path: `${OUT}/landing-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
          const contrast = await page.evaluate(contrastProbe);
          if (contrast.low.length) fail(`${label}: low contrast: ${contrast.low.slice(0, 6).join('; ')}`);
          if (width === 375 || width === 1440) {
            const t = await page.evaluate(typeProbe);
            const steps = { 'h1/h2': t.h1 / t.h2, 'h2/h3': t.h2 / t.h3, 'h2/body': t.h2 / t.body };
            note(`${label} type px: ${JSON.stringify(t)} steps: ${Object.entries(steps).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
            for (const [k, v] of Object.entries(steps)) if (v < MIN_STEP) fail(`${label}: ${k} step is ${v.toFixed(2)}`);
            note(`${label}: contrast checked on ${contrast.checked} text elements`);
            if (width === 1440 && theme === 'dark') await checkStructure(page);
            await checkDemo(page, label);
            await checkToggle(page, theme, label);
          }
        }
        if (errors.length) fail(`${label}: console errors: ${errors.join(' | ')}`);
        if (foreign.length) fail(`${label}: requests to other origins: ${foreign.join(' ')}`);
        await context.close();
      }
    }
    for (const width of [375, 1440]) {
      const { context, page } = await open(browser, origin, { width, theme: 'dark' });
      const shift = await page.evaluate(layoutShiftProbe);
      note(`dark ${width}px: cumulative layout shift ${shift.toFixed(4)}`);
      if (shift > 0.01) fail(`dark ${width}px: layout shift ${shift.toFixed(4)}`);
      await context.close();
      const still = await open(browser, origin, { width, theme: 'dark', reducedMotion: 'reduce' });
      const running = await still.page.evaluate(() =>
        document.getAnimations().map((a) => `${a.animationName ?? a.transitionProperty} on .${a.effect?.target?.className}`),
      );
      if (running.length) fail(`reduced motion ${width}px: still animating: ${running.join(', ')}`);
      await still.context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  for (const line of notes) process.stdout.write(`note  ${line}\n`);
  for (const line of failures) process.stdout.write(`FAIL  ${line}\n`);
  process.stdout.write(failures.length ? `\n${failures.length} problem(s)\n` : '\nlanding check passed\n');
  process.exitCode = failures.length ? 1 : 0;
}

await main();
