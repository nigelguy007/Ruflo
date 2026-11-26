import { useSyncExternalStore } from 'react';

/**
 * Bearer token for the API. It lives in sessionStorage only: closing the tab
 * forgets it, and nothing is ever written to localStorage or a cookie.
 */

const STORAGE_KEY = 'switchyard.token';

type Listener = () => void;

const listeners = new Set<Listener>();
let memoryToken: string | null = null;
let tokenRequired = false;
let tokenRejected = false;
let epoch = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode, strict settings): keep it for this page only.
    return memoryToken;
  }
}

export function setToken(token: string): void {
  const value = token.trim();
  memoryToken = value;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Fall back to the in-memory copy above.
  }
  tokenRequired = false;
  tokenRejected = false;
  epoch += 1;
  emit();
}

export function clearToken(): void {
  memoryToken = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to remove.
  }
  epoch += 1;
  emit();
}

/** Called by the data layer whenever the server answers 401. */
export function demandToken(): void {
  const rejected = getToken() !== null;
  if (tokenRequired && tokenRejected === rejected) return;
  tokenRequired = true;
  tokenRejected = rejected;
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the server is refusing us and the token prompt should be showing. */
export function useTokenRequired(): boolean {
  return useSyncExternalStore(subscribe, () => tokenRequired);
}

/** True when a token was sent and the server still said no. */
export function useTokenRejected(): boolean {
  return useSyncExternalStore(subscribe, () => tokenRejected);
}

/** Changes every time the token changes, so data hooks know to refetch. */
export function useAuthEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch);
}

export function useHasToken(): boolean {
  return useSyncExternalStore(subscribe, () => getToken() !== null);
}
