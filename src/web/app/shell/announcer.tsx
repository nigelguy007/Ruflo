import { useSyncExternalStore } from 'react';

/**
 * One polite live region for the whole console. Screens call `announce()`
 * when something happens that a screen-reader user would otherwise miss,
 * above all a new decision arriving in the Inbox.
 */

const listeners = new Set<() => void>();
let message = '';
let flip = false;

export function announce(text: string): void {
  // Alternate a trailing no-break space so repeating the same sentence is still announced.
  flip = !flip;
  message = flip ? text : `${text} `;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function LiveRegion() {
  const current = useSyncExternalStore(subscribe, () => message);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="live-region">
      {current}
    </div>
  );
}
