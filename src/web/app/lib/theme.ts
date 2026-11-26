import { useSyncExternalStore } from 'react';

/**
 * Light / dark preference. This is the one thing the console keeps in
 * localStorage. Until someone chooses, the theme follows the system.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'switchyard.theme';
const listeners = new Set<() => void>();

function readStored(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Call once before the first render. */
export function initTheme(): void {
  apply(readStored() ?? systemTheme());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (readStored() === null) apply(systemTheme());
  });
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage is blocked: the choice still applies to this page.
  }
  apply(theme);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme);
}
