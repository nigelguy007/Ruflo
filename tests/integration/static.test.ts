import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeWebDir, startServer } from './support.js';
import type { TestServer } from './support.js';

let server: TestServer | null = null;
let cleanup: (() => void) | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  cleanup?.();
  cleanup = null;
});

async function bootWithWeb(): Promise<{ target: TestServer; root: string; webDir: string }> {
  const web = makeWebDir();
  cleanup = web.remove;
  server = await startServer({ config: { webDir: web.webDir } });
  return { target: server, root: web.root, webDir: web.webDir };
}

async function get(target: TestServer, path: string): Promise<{ status: number; type: string | null; cache: string | null; text: string }> {
  const response = await target.app.request(path);
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    cache: response.headers.get('cache-control'),
    text: await response.text(),
  };
}

describe('static files', () => {
  test('serves the landing page at the root', async () => {
    const { target } = await bootWithWeb();

    const page = await get(target, '/');

    expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', cache: 'no-cache' });
    expect(page.text).toContain('<title>landing</title>');
  });

  test('serves the console for /app and for any console route that is not a file', async () => {
    const { target } = await bootWithWeb();

    for (const path of ['/app', '/app/', '/app/index.html', '/app/runs/x', '/app/runs/run_1/timeline']) {
      const page = await get(target, path);
      expect(page.status, path).toBe(200);
      expect(page.text, path).toContain('<title>console</title>');
    }
  });

  test('serves hashed assets with long-lived caching and the right types', async () => {
    const { target } = await bootWithWeb();

    const script = await get(target, '/assets/app-3f9a1c.js');
    const style = await get(target, '/assets/app-3f9a1c.css');
    const icon = await get(target, '/favicon.svg');

    expect(script).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', cache: 'public, max-age=31536000, immutable' });
    expect(script.text).toBe('export const answer = 42;');
    expect(style).toMatchObject({ status: 200, type: 'text/css; charset=utf-8' });
    expect(icon).toMatchObject({ status: 200, type: 'image/svg+xml', cache: 'public, max-age=3600' });
  });

  test('answers 404 for files that are not there', async () => {
    const { target } = await bootWithWeb();

    for (const path of ['/missing.js', '/assets/missing.js', '/assets', '/index.htm']) {
      const page = await get(target, path);
      expect(page.status, path).toBe(404);
    }
  });

  test('never serves a file from outside the web directory', async () => {
    const { target } = await bootWithWeb();

    const attempts = [
      '/..%2fpackage.json',
      '/assets/..%2f..%2fpackage.json',
      '/%2e%2e/package.json',
      '/app/..%2f..%2fpackage.json',
      '/..%5cpackage.json',
      '/%00index.html',
      '/%E0%A4%A',
      '/.hidden',
    ];
    for (const path of attempts) {
      const page = await get(target, path);
      expect(page.status, path).toBe(404);
      expect(page.text, path).not.toContain('outside the web directory');
    }
  });

  test('does not follow a link that leads out of the web directory', async () => {
    const { target, root, webDir } = await bootWithWeb();
    symlinkSync(join(root, 'package.json'), join(webDir, 'escape.json'));

    const page = await get(target, '/escape.json');

    expect(page.status).toBe(404);
  });

  test('answers HEAD without a body', async () => {
    const { target } = await bootWithWeb();

    const response = await target.app.request('/', { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  test('keeps API routes out of the file server', async () => {
    const { target } = await bootWithWeb();

    const response = await target.app.request('/api/index.html');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'not_found' } });
  });

  test('says how to build the console when it has not been built', async () => {
    server = await startServer({ config: { webDir: '/nonexistent/switchyard/web' } });

    const root = await get(server, '/');
    const consolePage = await get(server, '/app');

    expect(root.status).toBe(503);
    expect(root.type).toBe('text/plain; charset=UTF-8');
    expect(root.text).toContain('npm run build');
    expect(root.text.trim().split('\n')).toHaveLength(1);
    expect(consolePage.status).toBe(404);
  });
});
