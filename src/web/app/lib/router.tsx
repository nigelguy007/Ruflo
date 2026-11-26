import { useMemo, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import type { RunStatus } from '../../../shared/types';

/** History API routing under /app/. No library: the console has seven routes. */

const BASE = '/app';

export const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting_gate',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
];

export type Route =
  | { name: 'inbox' }
  | { name: 'floor' }
  | { name: 'runs'; status: RunStatus | null }
  | { name: 'run'; id: string }
  | { name: 'signals' }
  | { name: 'playbooks' }
  | { name: 'settings' }
  | { name: 'not_found' };

const listeners = new Set<() => void>();
let lastPathname = typeof window === 'undefined' ? '' : window.location.pathname;
let headingFocusPending = false;

function locationKey(): string {
  return window.location.pathname + window.location.search;
}

function notify(): void {
  if (window.location.pathname !== lastPathname) {
    lastPathname = window.location.pathname;
    headingFocusPending = true;
  }
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Turns an in-app path ("/runs/abc") into a real URL ("/app/runs/abc"). */
export function appHref(path: string): string {
  return path === '/' ? `${BASE}/` : `${BASE}${path}`;
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = appHref(path);
  if (target === locationKey()) return;
  const pathnameBefore = window.location.pathname;
  if (options.replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  if (window.location.pathname !== pathnameBefore) window.scrollTo(0, 0);
  notify();
}

/** True once after each page change; the page heading uses it to take focus. */
export function consumeHeadingFocus(): boolean {
  const pending = headingFocusPending;
  headingFocusPending = false;
  return pending;
}

function isRunStatus(value: string | null): value is RunStatus {
  return value !== null && (RUN_STATUSES as readonly string[]).includes(value);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string, search: string): Route {
  const inApp = pathname === BASE || pathname.startsWith(`${BASE}/`);
  const rest = inApp ? pathname.slice(BASE.length) : pathname;
  const segments = rest.split('/').filter(Boolean).map(safeDecode);
  const [first, second, ...extra] = segments;

  if (first === undefined) return { name: 'inbox' };
  if (first === 'runs' && second !== undefined && extra.length === 0) return { name: 'run', id: second };
  if (second !== undefined) return { name: 'not_found' };

  switch (first) {
    case 'floor':
      return { name: 'floor' };
    case 'runs': {
      const status = new URLSearchParams(search).get('status');
      return { name: 'runs', status: isRunStatus(status) ? status : null };
    }
    case 'signals':
      return { name: 'signals' };
    case 'playbooks':
      return { name: 'playbooks' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'not_found' };
  }
}

export function useRoute(): Route {
  const key = useSyncExternalStore(subscribe, locationKey);
  return useMemo(() => {
    const queryAt = key.indexOf('?');
    const pathname = queryAt === -1 ? key : key.slice(0, queryAt);
    const search = queryAt === -1 ? '' : key.slice(queryAt);
    return parseRoute(pathname, search);
  }, [key]);
}

export function runPath(id: string): string {
  return `/runs/${encodeURIComponent(id)}`;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** In-app path, starting with "/". */
  to: string;
}

/** A real anchor (so middle-click and copy-link work) that navigates in place. */
export function Link({ to, onClick, target, children, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    const plainLeftClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plainLeftClick || (target && target !== '_self')) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a {...rest} href={appHref(to)} target={target} onClick={handleClick}>
      {children}
    </a>
  );
}
