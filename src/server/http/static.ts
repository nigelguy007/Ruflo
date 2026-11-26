import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Context } from 'hono';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
const SHORT = 'public, max-age=3600';
const BUILD_HINT = 'The Switchyard console has not been built yet: run `npm run build`, then restart the server.\n';
const LANDING = 'index.html';
const CONSOLE = 'app/index.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * The URL path as a relative file path, or null when it cannot name a file
 * inside the web directory: undecodable, a NUL or backslash, or any segment
 * that starts with a dot (which covers `..` and hidden files).
 */
export function relativeFilePath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment.startsWith('.'))) return null;
  return segments.join('/');
}

function isConsolePath(urlPath: string): boolean {
  return urlPath === '/app' || urlPath.startsWith('/app/');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The real path of `relative` when it is a regular file that really lives under `root`. */
async function fileUnder(root: string, relative: string): Promise<string | null> {
  const full = resolve(root, relative);
  if (!full.startsWith(root + sep)) return null;
  try {
    const [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
    if (!real.startsWith(realRoot + sep)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

async function locate(root: string, urlPath: string): Promise<{ file: string; relative: string } | null> {
  const relative = relativeFilePath(urlPath);
  if (relative === null) return null;
  const wanted = relative === '' ? LANDING : relative;
  const file = await fileUnder(root, wanted);
  if (file !== null) return { file, relative: wanted };
  if (!isConsolePath(urlPath)) return null;
  // The console routes in the browser: any /app path that is not a real file gets its page.
  const page = await fileUnder(root, CONSOLE);
  return page === null ? null : { file: page, relative: CONSOLE };
}

function cacheControl(relative: string): string {
  if (relative.startsWith('assets/')) return IMMUTABLE;
  return extname(relative) === '.html' ? REVALIDATE : SHORT;
}

/** Serves the built console and landing page from `webDir`. */
export function createStaticHandler(webDir: string): (c: Context) => Promise<Response> {
  const root = resolve(webDir);
  return async (c) => {
    if (!(await isDirectory(root))) {
      return c.req.path === '/' ? c.text(BUILD_HINT, 503) : c.text('Not found\n', 404);
    }
    const found = await locate(root, c.req.path);
    if (found === null) return c.text('Not found\n', 404);
    const body = await readFile(found.file);
    return c.body(body, 200, {
      'Content-Type': CONTENT_TYPES[extname(found.relative).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': cacheControl(found.relative),
    });
  };
}
